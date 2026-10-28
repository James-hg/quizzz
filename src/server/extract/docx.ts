import "server-only";
import { posix } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { Corrupt } from "./errors";
import { extensionOf } from "./limits";
import type {
  Asset,
  Block,
  ExtractAnchor,
  ExtractLimits,
  ExtractResult,
  Extractor,
  TextRun,
  UploadedFile,
  Warning,
} from "./types";
import { inspectZip, readZipEntries } from "./zip";

/**
 * DOCX extractor. One source of truth: the OOXML parts read directly from the ZIP.
 *
 * Signals and where they come from:
 * - Text and run order: `word/document.xml` (`w:p` > `w:r` > `w:t`). Deleted tracked changes
 *   (`w:del`) are skipped; inserted ones (`w:ins`) are kept.
 * - Bold: the run's own `w:b`, else its character style (`w:rStyle`), else the paragraph style
 *   chain (`w:pStyle` + `w:basedOn`) from `word/styles.xml`. A run-level `w:b w:val="0"` turns
 *   inherited bold off. Word's toggle-property edge cases and document defaults are ignored.
 * - List level: `w:numPr/w:ilvl` on the paragraph, else on its style, else a built-in style name
 *   such as "List Number 2". `w:numId` of 0 means "no list".
 * - Headings: style names "Heading N" / "Title", used for the heading path anchor.
 * - Images: `a:blip`/`v:imagedata` relationship ids resolved through `word/_rels/document.xml.rels`.
 *   External (linked) images are never fetched; they are only reported.
 *
 * Mammoth is deliberately not used: it drops list levels and run-level bold detail, so the XML
 * would be needed anyway and two sources could disagree. Page numbers are never invented.
 * Macros are never executed (`vbaProject.bin` is only reported). Nothing is fetched.
 */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const MAX_STYLE_DEPTH = 10;

type XNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

function parseXml(bytes: Uint8Array): XNode[] {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  // Legitimate Word parts never declare entities or a DTD; refuse them (XXE, entity bombs).
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Corrupt();
  try {
    return parser.parse(text) as XNode[];
  } catch {
    throw new Corrupt();
  }
}

const tagOf = (node: XNode): string => Object.keys(node).find((k) => k !== ":@") ?? "";
const kids = (node: XNode): XNode[] => {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XNode[]) : [];
};
const attr = (node: XNode, name: string): string | undefined => {
  const attrs = node[":@"] as Record<string, string> | undefined;
  return attrs?.[`@_${name}`];
};
const child = (node: XNode, tag: string): XNode | undefined =>
  kids(node).find((n) => tagOf(n) === tag);
const textOf = (node: XNode): string =>
  kids(node)
    .map((n) => (typeof n["#text"] === "string" ? (n["#text"] as string) : ""))
    .join("");

/** Finds the first descendant with this tag (depth-first, document order). */
function findDeep(nodes: XNode[], tag: string): XNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === tag) return node;
    const found = findDeep(kids(node), tag);
    if (found) return found;
  }
  return undefined;
}

/** Word toggle values: absent => undefined, "0"/"false"/"off" => false, otherwise true. */
function toggle(parent: XNode | undefined, tag: string): boolean | undefined {
  if (!parent) return undefined;
  const el = child(parent, tag);
  if (!el) return undefined;
  const val = attr(el, "val");
  if (val === undefined) return true;
  return !["0", "false", "off"].includes(val.toLowerCase());
}

type StyleInfo = {
  name: string;
  basedOn?: string;
  bold?: boolean;
  numLevel?: number;
};

type ResolvedStyle = { name: string; bold: boolean; numLevel?: number };

function readStyles(bytes: Uint8Array | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!bytes) return styles;
  const root = parseXml(bytes).find((n) => tagOf(n) === "styles");
  if (!root) return styles;
  for (const style of kids(root).filter((n) => tagOf(n) === "style")) {
    const id = attr(style, "styleId");
    if (!id) continue;
    const pPr = child(style, "pPr");
    const numPr = pPr ? child(pPr, "numPr") : undefined;
    let numLevel: number | undefined;
    if (numPr) {
      const numId = attr(child(numPr, "numId") ?? {}, "val");
      if (numId !== "0") numLevel = Number(attr(child(numPr, "ilvl") ?? {}, "val") ?? 0) || 0;
    }
    styles.set(id, {
      name: attr(child(style, "name") ?? {}, "val") ?? id,
      basedOn: attr(child(style, "basedOn") ?? {}, "val"),
      bold: toggle(child(style, "rPr"), "b"),
      numLevel,
    });
  }
  return styles;
}

function resolveStyle(styles: Map<string, StyleInfo>, id: string | undefined): ResolvedStyle {
  let bold: boolean | undefined;
  let numLevel: number | undefined;
  let name = id ?? "";
  const seen = new Set<string>();
  let current = id;
  for (let depth = 0; current && depth < MAX_STYLE_DEPTH && !seen.has(current); depth++) {
    seen.add(current);
    const info = styles.get(current);
    if (!info) break;
    if (depth === 0) name = info.name;
    bold ??= info.bold;
    numLevel ??= info.numLevel;
    current = info.basedOn;
  }
  return { name, bold: bold ?? false, numLevel };
}

type Relationship = { target: string; external: boolean };

function readRelationships(bytes: Uint8Array | undefined): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  if (!bytes) return rels;
  const root = parseXml(bytes).find((n) => tagOf(n) === "Relationships");
  if (!root) return rels;
  for (const rel of kids(root).filter((n) => tagOf(n) === "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id && target) {
      rels.set(id, { target, external: attr(rel, "TargetMode")?.toLowerCase() === "external" });
    }
  }
  return rels;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  emf: "image/emf",
  wmf: "image/wmf",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const MONOSPACE = /^(consolas|courier new|courier|menlo|monaco|lucida console|source code pro)$/i;

/** Containers whose children may hold paragraphs; everything else under the body is skipped. */
const BLOCK_CONTAINERS = new Set([
  "body",
  "tbl",
  "tr",
  "tc",
  "sdt",
  "sdtContent",
  "ins",
  "customXml",
]);
/** Inline wrappers that contain runs. */
const INLINE_CONTAINERS = new Set([
  "hyperlink",
  "ins",
  "smartTag",
  "sdt",
  "sdtContent",
  "fldSimple",
  "customXml",
]);

function collectParagraphs(nodes: XNode[], out: XNode[]): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "p") out.push(node);
    else if (BLOCK_CONTAINERS.has(tag)) collectParagraphs(kids(node), out);
  }
}

type ParagraphContent = {
  runs: TextRun[];
  imageRels: string[];
  /** Author-written descriptions (`docPr descr`), by relationship id. */
  imageAlts: Map<string, string>;
};

function readRuns(
  nodes: XNode[],
  paragraphBold: boolean,
  styles: Map<string, StyleInfo>,
  out: ParagraphContent,
): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (INLINE_CONTAINERS.has(tag)) {
      readRuns(kids(node), paragraphBold, styles, out);
      continue;
    }
    if (tag !== "r") continue;

    const rPr = child(node, "rPr");
    const charStyle = attr(rPr ? (child(rPr, "rStyle") ?? {}) : {}, "val");
    const bold =
      toggle(rPr, "b") ??
      (charStyle ? resolveStyle(styles, charStyle).bold || undefined : undefined) ??
      paragraphBold;
    const italic = toggle(rPr, "i");
    const fonts = rPr ? child(rPr, "rFonts") : undefined;
    const code = fonts ? MONOSPACE.test(attr(fonts, "ascii") ?? "") : false;

    let text = "";
    for (const part of kids(node)) {
      const partTag = tagOf(part);
      if (partTag === "t") text += textOf(part);
      else if (partTag === "tab") text += "\t";
      else if (partTag === "br" || partTag === "cr") text += "\n";
      else if (partTag === "noBreakHyphen") text += "-";
      else if (partTag === "drawing" || partTag === "pict" || partTag === "object") {
        const blip = findDeep(kids(part), "blip");
        const legacy = findDeep(kids(part), "imagedata");
        const rel = blip
          ? (attr(blip, "embed") ?? attr(blip, "link"))
          : legacy
            ? attr(legacy, "id")
            : undefined;
        if (rel) {
          out.imageRels.push(rel);
          const description = attr(findDeep(kids(part), "docPr") ?? {}, "descr")?.trim();
          if (description && !out.imageAlts.has(rel)) out.imageAlts.set(rel, description);
        }
      }
    }
    if (text === "") continue;

    const run: TextRun = { text, bold };
    if (italic) run.italic = true;
    if (code) run.code = true;
    const prev = out.runs[out.runs.length - 1];
    if (prev && prev.bold === run.bold && prev.italic === run.italic && prev.code === run.code) {
      prev.text += text;
    } else {
      out.runs.push(run);
    }
  }
}

function listLevelOf(pPr: XNode | undefined, style: ResolvedStyle): number | undefined {
  const numPr = pPr ? child(pPr, "numPr") : undefined;
  if (numPr) {
    const numId = attr(child(numPr, "numId") ?? {}, "val");
    if (numId === "0") return undefined;
    return Number(attr(child(numPr, "ilvl") ?? {}, "val") ?? 0) || 0;
  }
  if (style.numLevel !== undefined) return style.numLevel;
  const builtIn = /^list (?:number|bullet)(?:\s+(\d+))?$/i.exec(style.name);
  if (builtIn) return builtIn[1] ? Math.max(0, Number(builtIn[1]) - 1) : 0;
  return undefined;
}

function headingLevelOf(style: ResolvedStyle): number | undefined {
  const match = /^heading\s*([1-9])$/i.exec(style.name);
  if (match) return Number(match[1]);
  if (/^title$/i.test(style.name)) return 1;
  return undefined;
}

export async function extractDocx(
  buffer: Buffer,
  limits: ExtractLimits,
  signal: AbortSignal,
): Promise<ExtractResult> {
  const entries = inspectZip(buffer, limits);
  const sizeByName = new Map(entries.map((e) => [e.name, e.declaredSize]));
  if (!sizeByName.has("word/document.xml")) throw new Corrupt("This is not a valid Word document.");

  const parts = readZipEntries(
    buffer,
    limits,
    (name) =>
      name === "word/document.xml" ||
      name === "word/styles.xml" ||
      name === "word/_rels/document.xml.rels",
  );
  signal.throwIfAborted();

  const styles = readStyles(parts.get("word/styles.xml"));
  const rels = readRelationships(parts.get("word/_rels/document.xml.rels"));
  const documentRoot = parseXml(parts.get("word/document.xml")!).find(
    (n) => tagOf(n) === "document",
  );
  const body = documentRoot ? child(documentRoot, "body") : undefined;
  if (!body) throw new Corrupt("This is not a valid Word document.");

  const paragraphs: XNode[] = [];
  collectParagraphs([body], paragraphs);

  const blocks: Block[] = [];
  const assets: Asset[] = [];
  const warnings: Warning[] = [];
  const assetByTarget = new Map<string, string>();
  let headingPath: string[] = [];

  if (sizeByName.has("word/vbaProject.bin")) {
    warnings.push({
      code: "macros_ignored",
      message: "This document contains macros. They were not read or run.",
    });
  }

  for (const [index, paragraph] of paragraphs.entries()) {
    if (index % 200 === 0) signal.throwIfAborted();

    const pPr = child(paragraph, "pPr");
    const styleId = attr(pPr ? (child(pPr, "pStyle") ?? {}) : {}, "val");
    const style = resolveStyle(styles, styleId);

    const content: ParagraphContent = { runs: [], imageRels: [], imageAlts: new Map() };
    readRuns(kids(paragraph), style.bold, styles, content);

    const anchorBase = { type: "docx_paragraph" as const, index };

    if (content.imageRels.length > 0) {
      const anchor: ExtractAnchor = { ...anchorBase, headingPath: [...headingPath] };
      warnings.push({
        code: "image_dependency",
        message:
          "This part contains an image that was not imported. The question may depend on it.",
        anchor,
      });
      for (const relId of new Set(content.imageRels)) {
        const rel = rels.get(relId);
        if (!rel || rel.external) {
          warnings.push({
            code: "external_image",
            message: "A linked image was not fetched.",
            anchor,
          });
          continue;
        }
        const path = rel.target.startsWith("/")
          ? rel.target.slice(1)
          : posix.normalize(posix.join("word", rel.target));
        if (!path.startsWith("word/") || assetByTarget.has(path)) continue;
        const id = `img-${assets.length + 1}`;
        assetByTarget.set(path, id);
        assets.push({
          id,
          mimeType: IMAGE_MIME[extensionOf(path)] ?? "application/octet-stream",
          sizeBytes: sizeByName.get(path) ?? 0,
          anchor,
          entryName: path,
          ...(content.imageAlts.get(relId) ? { alt: content.imageAlts.get(relId) } : {}),
        });
      }
    }

    const text = content.runs.map((r) => r.text).join("");
    if (text.trim() === "") continue;

    const headingLevel = headingLevelOf(style);
    if (headingLevel !== undefined) {
      headingPath = [...headingPath.slice(0, headingLevel - 1), text.trim()];
    }
    const listLevel = headingLevel === undefined ? listLevelOf(pPr, style) : undefined;

    const block: Block = {
      id: `p${index}`,
      kind:
        headingLevel !== undefined
          ? "heading"
          : listLevel !== undefined
            ? "list_item"
            : "paragraph",
      text,
      runs: content.runs.map((r) => ({ ...r, bold: r.bold || undefined })),
      anchor: { ...anchorBase, headingPath: [...headingPath] },
    };
    if (listLevel !== undefined) block.listLevel = listLevel;
    blocks.push(block);
  }

  return { blocks, assets, warnings, meta: { format: "docx" } };
}

export const docxExtractor: Extractor = {
  name: "docx",
  formats: [{ extension: "docx", label: "Word (.docx)" }],
  canHandle(file: UploadedFile): boolean {
    if (extensionOf(file.filename) !== "docx") return false;
    return (
      !file.detectedMime ||
      file.detectedMime === DOCX_MIME ||
      file.detectedMime === "application/zip"
    );
  },
  extract: extractDocx,
};
