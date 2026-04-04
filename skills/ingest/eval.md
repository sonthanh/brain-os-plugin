# Ingest Eval

## Q1: Input and Output Paths
type: grep
patterns:
  - "knowledge/raw"
  - "knowledge/books"
pass: all patterns found
why: Ingest reads from raw/ and writes structured notes to books/ — wrong paths = lost knowledge

## Q2: Book Note Structure
type: grep
patterns:
  - "## Key"
  - "## Framework"
pass: at least one pattern found
why: Output must follow a structured template with key insights and frameworks

## Q3: Processing Marker
type: grep
patterns:
  - "processed"
  - "_index"
pass: at least one pattern found
why: Must track which books have been ingested to prevent re-processing
