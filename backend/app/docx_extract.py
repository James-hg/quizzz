import re
from typing import IO, Union

from docx import Document


# regex fallbacks for manual numbering/lettering
Q_RE = re.compile(r"^(question\s*\d+|q\s*\d+|\d+[\.\)])\s+", re.I)
OPT_RE = re.compile(r"^([A-Ha-h][\.\)])\s+", re.I)


def classify_paragraph(p):
    text = p.text.strip()
    if not text:
        return ("EMPTY", None)

    # A) list metadata / style inference
    lvl = get_list_level(p)
    if lvl == 0:
        return ("QUESTION", text)
    if lvl == 1:
        return ("OPTION", text)

    # B) regex fallback (manual numbering)
    if Q_RE.match(text):
        return ("QUESTION", Q_RE.sub("", text).strip())
    if OPT_RE.match(text):
        return ("OPTION", OPT_RE.sub("", text).strip())

    # C) unknown
    return ("OTHER", text)


def get_list_level(paragraph):
    """
    Returns an integer level:
      0 = question-level list item
      1 = option-level list item
    or None if not a list item we care about.
    """

    # A) Try direct numbering (sometimes exists)
    pPr = paragraph._p.pPr
    if pPr is not None and pPr.numPr is not None and pPr.numPr.ilvl is not None:
        return int(pPr.numPr.ilvl.val)

    # B) Fallback: infer from style name (very common)
    style_name = (paragraph.style.name or "").lower()

    # Typical Word built-in list styles:
    # "List Number" (level 0), "List Number 2" (level 1) ...
    if style_name.startswith("list number"):
        # style could be "List Number", "List Number 2", "List Number 3"
        parts = style_name.split()
        if parts[-1].isdigit():
            return int(parts[-1]) - 1   # "2" => level 1
        return 0  # plain "List Number" => level 0

    # Sometimes it's "List Paragraph" with nested indentation; handle later if needed
    return None


def is_correct_option(paragraph):
    """
    Returns true if is Bold
    """
    for run in paragraph.runs:
        if run.text.strip() and run.bold:
            return True
    return False


def parse_docx_mcq(source: Union[str, IO[bytes]]):
    """
    Accepts a filesystem path or a binary file-like object.
    """
    doc = Document(source)
    draft = {"title": "Imported Quiz", "questions": [], "warnings": []}

    current_q = None
    last_kind = None  # track whether we last saw QUESTION or OPTION

    for p in doc.paragraphs:
        kind, text = classify_paragraph(p)
        if kind == "EMPTY":
            continue

        # Heuristics for bullet-only lists where list level info is missing:
        # - If we have a current question and we see another "QUESTION" that
        #   doesn't look like a question (no '?', not numbered), treat it as an
        #   option instead.
        if kind == "QUESTION" and current_q is not None:
            looks_like_question = "?" in text or Q_RE.match(p.text.strip())
            if not looks_like_question:
                kind = "OPTION"

        if kind == "QUESTION":
            current_q = {"text": text, "options": []}
            draft["questions"].append(current_q)
            last_kind = "QUESTION"

        elif kind == "OPTION":
            if current_q is None:
                draft["warnings"].append(
                    f"Option without a question: {text[:40]}")
                continue

            current_q["options"].append({
                "text": text,
                "isCorrect": is_correct_option(p),
            })
            last_kind = "OPTION"

        else:  # OTHER
            # Attach wrapped lines to the most recent item (question or option)
            if current_q is None:
                # ignore leading junk (title, instructions) safely
                continue

            if last_kind == "OPTION" and current_q["options"]:
                # option wrapped onto next line
                current_q["options"][-1]["text"] += " " + text
            else:
                # question wrapped onto next line
                current_q["text"] += " " + text

    # validation warnings
    for i, q in enumerate(draft["questions"], 1):
        if len(q["options"]) < 2:
            draft["warnings"].append(f"Question {i} has <2 options.")
        if sum(o["isCorrect"] for o in q["options"]) != 1:
            draft["warnings"].append(
                f"Question {i} does not have exactly 1 bold answer.")

    return draft


def display_questions(doc):
    for i, q in enumerate(parse_docx_mcq(doc)["questions"]):
        # print chunks
        # print(i, q)

        # print question text
        print(f"Question {i + 1}: ", q["text"])

        # print options with correct answer
        print("Options:")
        for c in q["options"]:
            print(c["text"], end=' ')
            print("True") if c["isCorrect"] else print()
        print("\n")


# display_questions(doc)

def docx_extract(source: IO[bytes]):
    """
    Takes in a file-like object for a docx.
    Returns a dict of questions.
    """
    return parse_docx_mcq(source)
