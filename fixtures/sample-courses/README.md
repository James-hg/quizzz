# Sample courses

A sample course is a checked, ready-made course a student can copy into their account to
explore the app ("Explore a sample course"). There is **one per language**: `python`, `java`,
`c`, `cpp`, `javascript`.

**The content is written and checked by the project owner.** Do not generate it with a model.
This folder holds only the format, a template, and (once added) the real samples. If it has no
language folders, the app simply shows no samples.

## Adding a sample

1. Copy `_template/course.yaml` to `<language>/course.yaml` (the folder name must be the
   language).
2. Replace everything, following the comments in the template.
3. Run the validator until it is clean:

   ```sh
   npm run samples:validate
   ```

   Problems are reported as `file:line  path: message`, for example:

   ```text
   fixtures/sample-courses/python/course.yaml:27  questions[0].correctOptionId: unknown field "correctOptionId" for a mcq_single question (did you mean "correctOptionIds"?)
   ```

4. Try it end to end (needs a signed-up user and the database running):

   ```sh
   npm run samples:load -- python --email you@example.com
   ```

CI runs `npm run samples:validate` on every pull request, so a broken sample cannot merge.

## Format at a glance

| Key | Meaning |
| --- | --- |
| `format` | Always `1` |
| `course` | `title`, `subject`, `language` |
| `sections` | Optional source material: `id`, `title`, `text` (blank line = new paragraph) |
| `questions` | The same fields as the question editor, plus `id`, optional `sections` (refs) and `provenance` |
| `provenance` | `checkedBy` and `checkedAt` (`YYYY-MM-DD`). Marks an item as checked |

Question types: `mcq_single`, `mcq_multi` (`options` + `correctOptionIds`), `short_answer`,
`output_prediction` (`accepted`), `fill_blank` (`blanks`). Unknown fields are errors.

## What loading does

- Creates a normal course the student owns (they can edit or delete it), with a question set
  whose origin is `sample`, the sections as source segments, and links from each question to the
  sections it cites. The fixture file is kept privately as the source document.
- A question **with** `provenance` is loaded as *human reviewed*. A question **without** it is
  loaded as *needs review* and is not used in practice until the student approves it.
- Loading the same sample twice for one user does not make a second copy: the existing one is
  returned, untouched (edits are never overwritten, and later fixture changes do not alter
  existing copies). Delete the copy to get a fresh one.
