# One PDF project overview
- Purpose: Static, privacy-first PDF page merger for GitHub Pages.
- Stack: HTML, CSS, vanilla JavaScript (ES modules), `pdf-lib` loaded from jsDelivr CDN.
- Architecture: Single-page static app (`index.html`) with UI styles (`styles.css`) and logic (`app.js`).
- Core MVP flow: select multiple PDFs, page-level include/exclude toggles (default included), export merged PDF locally in browser.