# planning

## libraries

- `python-docx` - structured access (paragraphs)
- `docx2txt` - simples one-liner dump of text
- `mammoth` - html preserved output
- `textract` - general extractor

## docx_extract logic

- [x] extract text from docx using python-docx
- [x] split into chunks (question with choices)
- [x] identify correct choice
- [x] store into a dict (JSON format)
- [x] return a JSON format

## creating and editing quizzes

Importing:

- [x] button in main comp for importing
- [x] clicking it will pop up a window containing:
  - [x] upload button
  - [x] extract button
  - [ ] rules for docx file

- [x] create button always appear at the bottom
- [x] clicking that button will create a new question, with boxes for the user to enter
- [x] a box for question
- [x] 4 boxes for choices, next to those will be a tick box for right answer
- [ ] a button to upload image
- [ ] a button to shuffle questions
- [ ] a button to shuffle choices

Optional features:

- [ ] AI chatbot on right sidebar for assisting with questions and answers
- [ ] AI changes numbers/some choices for more challenging
- [ ] When importing, question numbers might appear while playing, option to remove it
- [ ] (optional) explaination per question

## mcq quiz logic

- [ ] directs user to the quiz page
- [ ] display:
  - [ ] quiz name
  - [ ] best record
  - [ ] performance chart (implement later)
- [ ] a start button
- [ ] a back to homepage button

Once started (maybe another endpoint?):

Display:

- [x] huge question box
- [ ] image if exist
- [x] boxes for choices
- [x] submit button at the bottom
- [x] progress quiz bar

Once submitted:

- [x] make the correct box fades to green
- [x] if user answer's wrong, fade into red
- [x] continue to next question

Optional features:

- [ ] no answer reveal for all
- [ ] no answer reveal for wrong questions, append wrong question to the back
