import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const elements = {
  fileInput: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  fileList: document.querySelector("#file-list"),
  mergeButton: document.querySelector("#merge-button"),
  resetButton: document.querySelector("#reset-button"),
  feedback: document.querySelector("#feedback"),
  fileCount: document.querySelector("#file-count"),
  selectedPages: document.querySelector("#selected-pages"),
  exportSummary: document.querySelector("#export-summary"),
  sessionStatus: document.querySelector("#session-status"),
  fileCardTemplate: document.querySelector("#file-card-template"),
};

const state = {
  documents: [],
  exporting: false,
};

elements.fileInput.addEventListener("change", (event) => {
  void handleFiles(event.target.files);
  elements.fileInput.value = "";
});

elements.resetButton.addEventListener("click", resetSession);
elements.mergeButton.addEventListener("click", () => void exportMergedPdf());

setupDropzone();
render();

window.onePdfApp = {
  handleFiles,
  exportMergedPdf,
  resetSession,
  getStateSnapshot: () =>
    state.documents.map((documentState) => ({
      name: documentState.name,
      pageCount: documentState.pageCount,
      selections: [...documentState.selections],
    })),
};

function setupDropzone() {
  const preventDefaults = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, preventDefaults);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, () => {
      elements.dropzone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, () => {
      elements.dropzone.classList.remove("is-dragging");
    });
  });

  elements.dropzone.addEventListener("drop", (event) => {
    void handleFiles(event.dataTransfer?.files);
  });

  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList ?? []).filter(isPdfFile);

  if (!files.length) {
    setFeedback("Please choose at least one valid PDF file.");
    elements.sessionStatus.textContent = "Waiting";
    return;
  }

  elements.sessionStatus.textContent = "Parsing";
  setFeedback("Reading PDF files locally in your browser...");

  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const pdf = await PDFDocument.load(bytes);
      const pageCount = pdf.getPageCount();

      state.documents.push({
        id: createDocumentId(),
        name: file.name,
        size: file.size,
        bytes,
        pageCount,
        selections: Array(pageCount).fill(true),
      });
    } catch (error) {
      console.error(error);
      setFeedback(`Could not read ${file.name}. Make sure the file is a valid PDF.`);
      elements.sessionStatus.textContent = "Error";
    }
  }

  if (state.documents.length) {
    elements.sessionStatus.textContent = "Ready";
    setFeedback("Every page starts included. Uncheck pages you want to exclude before exporting.");
  }

  render();
}

function resetSession() {
  state.documents = [];
  state.exporting = false;
  setFeedback("Add PDF files to start selecting pages.");
  elements.sessionStatus.textContent = "Idle";
  render();
}

function setFeedback(message) {
  elements.feedback.textContent = message;
}

function render() {
  const selectedCount = getSelectedPageCount();

  elements.fileCount.textContent = String(state.documents.length);
  elements.selectedPages.textContent = String(selectedCount);
  elements.exportSummary.textContent = `${selectedCount} selected ${selectedCount === 1 ? "page" : "pages"}`;
  elements.mergeButton.disabled = selectedCount === 0 || state.exporting;
  elements.mergeButton.textContent = state.exporting ? "Exporting..." : "Export one PDF";
  elements.fileList.replaceChildren();

  state.documents.forEach((documentState) => {
    const fileCard = elements.fileCardTemplate.content.firstElementChild.cloneNode(true);
    fileCard.querySelector(".file-name").textContent = documentState.name;
    fileCard.querySelector(".file-meta").textContent = `${documentState.pageCount} pages • ${formatBytes(documentState.size)}`;

    fileCard.querySelector(".select-all").addEventListener("click", () => {
      documentState.selections = documentState.selections.map(() => true);
      render();
    });

    fileCard.querySelector(".clear-all").addEventListener("click", () => {
      documentState.selections = documentState.selections.map(() => false);
      render();
    });

    fileCard.querySelector(".invert-selection").addEventListener("click", () => {
      documentState.selections = documentState.selections.map((value) => !value);
      render();
    });

    const pageGrid = fileCard.querySelector(".page-grid");

    documentState.selections.forEach((isSelected, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "page-toggle";

      const checkboxId = `${documentState.id}-page-${index + 1}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = checkboxId;
      input.checked = isSelected;
      input.addEventListener("change", () => {
        documentState.selections[index] = input.checked;
        render();
      });

      const label = document.createElement("label");
      label.htmlFor = checkboxId;
      label.innerHTML = `<strong>${index + 1}</strong><span>${input.checked ? "Included" : "Excluded"}</span>`;

      wrapper.append(input, label);
      pageGrid.append(wrapper);
    });

    elements.fileList.append(fileCard);
  });
}

async function exportMergedPdf() {
  const selectedCount = getSelectedPageCount();

  if (!selectedCount) {
    setFeedback("Select at least one page before exporting.");
    return;
  }

  state.exporting = true;
  elements.sessionStatus.textContent = "Exporting";
  setFeedback("Building your merged PDF locally...");
  render();

  try {
    const mergedPdf = await PDFDocument.create();

    for (const documentState of state.documents) {
      const sourcePdf = await PDFDocument.load(documentState.bytes);
      const pageIndexes = documentState.selections
        .map((isSelected, index) => (isSelected ? index : -1))
        .filter((index) => index !== -1);

      if (!pageIndexes.length) {
        continue;
      }

      const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndexes);
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();
    const blob = new Blob([mergedBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "one-pdf-merged.pdf";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    setFeedback("Merged PDF exported successfully.");
    elements.sessionStatus.textContent = "Done";
  } catch (error) {
    console.error(error);
    setFeedback("Something went wrong while exporting the merged PDF.");
    elements.sessionStatus.textContent = "Error";
  } finally {
    state.exporting = false;
    render();
  }
}

function getSelectedPageCount() {
  return state.documents.reduce(
    (total, documentState) => total + documentState.selections.filter(Boolean).length,
    0,
  );
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function isPdfFile(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function createDocumentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `pdf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
