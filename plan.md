# planning

## libraries

- `python-docx` - structured access (paragraphs)
- `docx2txt` - simples one-liner dump of text
- `mammoth` - html preserved output
- `textract` - general extractor

## logic

- extract text from docx using python-docx or docx2txt
- split into chunks (question with choices)
- identify correct choice
- store into array/objects
- go through each and append as .csv
