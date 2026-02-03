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

- [ ] button on navbar next to user icon
- [ ] clicking it will pop up a window containing:
  - [ ] upload button
  - [ ] extract button
  - [ ] rules for docx file

- [ ] create button always appear at the bottom
- [ ] clicking that button will create a new question, with boxes for the user to enter
- [ ] a box for question
- [ ] 4 boxes for choices, next to those will be a tick box for right answer
- [ ] a button to upload image
- [ ] (optional) explaination per question

- [ ] AI chatbot on right sidebar for assisting with questions and answers

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

- [ ] question
- [ ] choices
- [ ] answer
- [ ] time remaining
