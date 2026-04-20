import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs";

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
  exportDetails: document.querySelector("#export-details"),
  exportFilename: document.querySelector("#export-filename"),
  summaryTotalFiles: document.querySelector("#summary-total-files"),
  summarySelectedFiles: document.querySelector("#summary-selected-files"),
  summarySelectedPages: document.querySelector("#summary-selected-pages"),
  summaryFileList: document.querySelector("#summary-file-list"),
  sessionStatus: document.querySelector("#session-status"),
  fileCardTemplate: document.querySelector("#file-card-template"),
};

const VISIBLE_THUMBNAIL_ROOT_MARGIN = "240px";

const state = {
  documents: [],
  exporting: false,
  exportFilename: "",
  exportFilenameTouched: false,
  thumbnailObserver: null,
  renderScheduled: false,
  dragState: {
    draggedDocumentId: null,
    dropTargetDocumentId: null,
  },
};

elements.fileInput.addEventListener("change", (event) => {
  void handleFiles(event.target.files);
  elements.fileInput.value = "";
});

elements.resetButton.addEventListener("click", resetSession);
elements.mergeButton.addEventListener("click", () => void exportMergedPdf());
elements.exportFilename.addEventListener("input", () => {
  state.exportFilename = elements.exportFilename.value;
  state.exportFilenameTouched = true;
  renderExportMeta();
});

setupDropzone();
render();

window.onePdfApp = {
  handleFiles,
  exportMergedPdf,
  resetSession,
  moveDocument,
  reorderDocumentById,
  applyRangeSelection,
  getStateSnapshot: () =>
    state.documents.map((documentState, index) => ({
      order: index,
      name: documentState.name,
      pageCount: documentState.pageCount,
      selections: [...documentState.selections],
      rangeDraft: documentState.rangeDraft,
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

  elements.sessionStatus.textContent = "Loading";
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
        rangeDraft: "",
        thumbnails: Array(pageCount).fill(null),
        inflightThumbnails: new Set(),
        thumbnailStatus: "idle",
        pdfjsDocumentPromise: null,
      });
    } catch (error) {
      console.error(error);
      setFeedback(`Could not read ${file.name}. Make sure the file is a valid PDF.`);
      elements.sessionStatus.textContent = "Error";
    }
  }

  if (state.documents.length) {
    syncSuggestedExportFilename();
    elements.sessionStatus.textContent = "Ready";
    setFeedback("Every page starts included. Uncheck pages you want to exclude before exporting.");
  }

  render();
}

function resetSession() {
  state.documents = [];
  state.exporting = false;
  state.exportFilename = "";
  state.exportFilenameTouched = false;
  state.dragState.draggedDocumentId = null;
  state.dragState.dropTargetDocumentId = null;
  disconnectThumbnailObserver();
  setFeedback("Add PDF files to start selecting pages.");
  elements.sessionStatus.textContent = "Idle";
  render();
}

function setFeedback(message) {
  elements.feedback.textContent = message;
}

function render() {
  state.renderScheduled = false;
  const selectedCount = getSelectedPageCount();

  elements.fileCount.textContent = String(state.documents.length);
  elements.selectedPages.textContent = String(selectedCount);
  elements.mergeButton.disabled = selectedCount === 0 || state.exporting;
  elements.mergeButton.textContent = state.exporting ? "Exporting..." : "Export one PDF";
  renderExportMeta();
  renderSelectionSummary();
  elements.fileList.replaceChildren();

  state.documents.forEach((documentState, index) => {
    const fileCard = elements.fileCardTemplate.content.firstElementChild.cloneNode(true);
    fileCard.draggable = true;
    fileCard.dataset.documentId = documentState.id;
    if (state.dragState.draggedDocumentId === documentState.id) {
      fileCard.classList.add("is-dragging-file");
    }
    if (state.dragState.dropTargetDocumentId === documentState.id) {
      fileCard.classList.add("is-drop-target");
    }

    attachFileDragHandlers(fileCard, documentState.id);

    fileCard.querySelector(".file-name").textContent = documentState.name;
    fileCard.querySelector(".file-order-hint").textContent = `Merge order: file ${index + 1}`;
    fileCard.querySelector(".file-meta").textContent = `${documentState.pageCount} pages • ${formatBytes(documentState.size)}`;
    const rangeInput = fileCard.querySelector(".range-input");
    rangeInput.value = documentState.rangeDraft;
    rangeInput.addEventListener("input", () => {
      documentState.rangeDraft = rangeInput.value;
    });

    const moveUpButton = fileCard.querySelector(".move-up");
    const moveDownButton = fileCard.querySelector(".move-down");
    moveUpButton.disabled = index === 0;
    moveDownButton.disabled = index === state.documents.length - 1;
    moveUpButton.addEventListener("click", () => moveDocument(index, index - 1));
    moveDownButton.addEventListener("click", () => moveDocument(index, index + 1));

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

    fileCard.querySelector(".apply-include").addEventListener("click", () => {
      applyRangeSelection(index, documentState.rangeDraft, "include");
    });

    fileCard.querySelector(".apply-exclude").addEventListener("click", () => {
      applyRangeSelection(index, documentState.rangeDraft, "exclude");
    });

    const pageGrid = fileCard.querySelector(".page-grid");

    documentState.selections.forEach((isSelected, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "page-toggle";
      wrapper.dataset.documentId = documentState.id;
      wrapper.dataset.pageIndex = String(index);

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
      label.innerHTML = createPageCardMarkup(documentState, index, input.checked);

      wrapper.append(input, label);
      pageGrid.append(wrapper);
    });

    elements.fileList.append(fileCard);
  });

  observeVisibleThumbnails();
}

function scheduleRender() {
  if (state.renderScheduled) {
    return;
  }

  state.renderScheduled = true;
  window.requestAnimationFrame(() => {
    render();
  });
}

async function exportMergedPdf() {
  const selectedCount = getSelectedPageCount();
  const exportFileName = getNormalizedExportFilename();

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
    anchor.download = exportFileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    setFeedback(`${exportFileName} exported successfully.`);
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

function getSelectedFileCount() {
  return state.documents.filter((documentState) => documentState.selections.some(Boolean)).length;
}

function renderExportMeta() {
  const selectedPages = getSelectedPageCount();
  const selectedFiles = getSelectedFileCount();
  const exportFileName = getNormalizedExportFilename();

  if (elements.exportFilename.value !== state.exportFilename) {
    elements.exportFilename.value = state.exportFilename;
  }
  elements.exportSummary.textContent = `${selectedPages} selected ${selectedPages === 1 ? "page" : "pages"}`;
  elements.exportDetails.textContent = `Your export will include ${selectedFiles} ${selectedFiles === 1 ? "file" : "files"} and ${selectedPages} selected ${selectedPages === 1 ? "page" : "pages"}. Output name: ${exportFileName}`;
}

function renderSelectionSummary() {
  const selectedFiles = getSelectedFileCount();
  const selectedPages = getSelectedPageCount();

  elements.summaryTotalFiles.textContent = String(state.documents.length);
  elements.summarySelectedFiles.textContent = String(selectedFiles);
  elements.summarySelectedPages.textContent = String(selectedPages);
  elements.summaryFileList.replaceChildren();

  if (!state.documents.length) {
    const empty = document.createElement("p");
    empty.className = "summary-empty";
    empty.textContent = "Add PDF files to see a per-file selection summary.";
    elements.summaryFileList.append(empty);
    return;
  }

  state.documents.forEach((documentState, index) => {
    const selectedPageNumbers = getSelectedPageNumbers(documentState.selections);
    const excludedPageNumbers = getExcludedPageNumbers(documentState.selections);
    const item = document.createElement("article");
    item.className = "summary-file-item";
    item.innerHTML = `
      <div class="summary-file-header">
        <div>
          <strong>${escapeHtml(documentState.name)}</strong>
          <p class="summary-meta">Merge order: file ${index + 1} · ${documentState.pageCount} pages total</p>
        </div>
        <strong>${selectedPageNumbers.length} selected</strong>
      </div>
      <p class="summary-pages">${getSelectionSummaryText(selectedPageNumbers, documentState.pageCount)}</p>
      <p class="summary-pages excluded-pages">${getExcludedSummaryText(excludedPageNumbers, documentState.pageCount)}</p>
    `;

    elements.summaryFileList.append(item);
  });
}

function getNormalizedExportFilename() {
  const rawName = state.exportFilename.trim() || getSuggestedExportBaseName();
  const trimmed = rawName.trim();
  const safeBaseName = trimmed
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const finalBaseName = safeBaseName || "one-pdf-merged";
  return finalBaseName.toLowerCase().endsWith(".pdf") ? finalBaseName : `${finalBaseName}.pdf`;
}

function syncSuggestedExportFilename() {
  if (state.exportFilenameTouched) {
    return;
  }

  state.exportFilename = getSuggestedExportBaseName();
}

function getSuggestedExportBaseName() {
  const firstDocument = state.documents[0];

  if (!firstDocument) {
    return "one-pdf-merged";
  }

  const originalName = firstDocument.name.replace(/\.pdf$/i, "");
  return `${originalName}-merged`;
}

function getSelectedPageNumbers(selections) {
  return selections
    .map((isSelected, index) => (isSelected ? index + 1 : null))
    .filter((pageNumber) => pageNumber !== null);
}

function getExcludedPageNumbers(selections) {
  return selections
    .map((isSelected, index) => (!isSelected ? index + 1 : null))
    .filter((pageNumber) => pageNumber !== null);
}

function getSelectionSummaryText(selectedPageNumbers, totalPages) {
  if (!selectedPageNumbers.length) {
    return "No pages selected yet.";
  }

  if (selectedPageNumbers.length === totalPages) {
    return "All pages are currently included.";
  }

  return `Included pages: ${formatPageRanges(selectedPageNumbers)}`;
}

function getExcludedSummaryText(excludedPageNumbers, totalPages) {
  if (!excludedPageNumbers.length) {
    return "Excluded pages: none.";
  }

  if (excludedPageNumbers.length === totalPages) {
    return "Excluded pages: all pages.";
  }

  return `Excluded pages: ${formatPageRanges(excludedPageNumbers)}`;
}

function formatPageRanges(pageNumbers) {
  if (!pageNumbers.length) {
    return "none";
  }

  const ranges = [];
  let start = pageNumbers[0];
  let previous = pageNumbers[0];

  for (let index = 1; index < pageNumbers.length; index += 1) {
    const current = pageNumbers[index];

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = current;
    previous = current;
  }

  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);

  const compact = ranges.join(", ");
  return compact.length > 72 ? `${compact.slice(0, 72).trimEnd()}, …` : compact;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function moveDocument(fromIndex, toIndex) {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= state.documents.length ||
    toIndex >= state.documents.length ||
    fromIndex === toIndex
  ) {
    return;
  }

  const [movedDocument] = state.documents.splice(fromIndex, 1);
  state.documents.splice(toIndex, 0, movedDocument);
  syncSuggestedExportFilename();
  state.dragState.draggedDocumentId = null;
  state.dragState.dropTargetDocumentId = null;
  setFeedback(`Order updated. ${movedDocument.name} is now file ${toIndex + 1} in the merge.`);
  render();
}

function reorderDocumentById(draggedDocumentId, targetDocumentId) {
  if (!draggedDocumentId || !targetDocumentId || draggedDocumentId === targetDocumentId) {
    return;
  }

  const fromIndex = state.documents.findIndex((documentState) => documentState.id === draggedDocumentId);
  const toIndex = state.documents.findIndex((documentState) => documentState.id === targetDocumentId);

  if (fromIndex === -1 || toIndex === -1) {
    return;
  }

  moveDocument(fromIndex, toIndex);
}

function applyRangeSelection(documentIndex, rangeText, mode) {
  const documentState = state.documents[documentIndex];

  if (!documentState) {
    return;
  }

  const normalizedRange = rangeText.trim();

  if (!normalizedRange) {
    setFeedback("Enter a page range first. Example: 1-3,5,8");
    return;
  }

  const parsedPages = parsePageRange(normalizedRange, documentState.pageCount);

  if (!parsedPages.ok) {
    setFeedback(`${documentState.name}: ${parsedPages.message}`);
    return;
  }

  const pageIndexes = new Set(parsedPages.pages.map((pageNumber) => pageNumber - 1));

  if (mode === "include") {
    documentState.selections = documentState.selections.map((_, index) => pageIndexes.has(index));
    setFeedback(`Applied include range ${parsedPages.summary} to ${documentState.name}.`);
  } else {
    documentState.selections = documentState.selections.map((isSelected, index) => (
      pageIndexes.has(index) ? false : isSelected
    ));
    setFeedback(`Excluded range ${parsedPages.summary} from ${documentState.name}.`);
  }

  documentState.rangeDraft = normalizedRange;
  render();
}

function parsePageRange(rangeText, maxPage) {
  const tokens = rangeText
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (!tokens.length) {
    return { ok: false, message: "Please enter a non-empty range." };
  }

  const pages = new Set();

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const pageNumber = Number(token);
      if (pageNumber < 1 || pageNumber > maxPage) {
        return { ok: false, message: `Page ${pageNumber} is out of range. The file has ${maxPage} pages.` };
      }

      pages.add(pageNumber);
      continue;
    }

    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!rangeMatch) {
      return { ok: false, message: `"${token}" is not a valid format. Example: 1-3,5,8.` };
    }

    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start > end) {
      return { ok: false, message: `${token} is invalid because the start page cannot be greater than the end page.` };
    }

    if (start < 1 || end > maxPage) {
      return { ok: false, message: `${token} must stay between page 1 and page ${maxPage}.` };
    }

    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      pages.add(pageNumber);
    }
  }

  const sortedPages = [...pages].sort((left, right) => left - right);
  return {
    ok: true,
    pages: sortedPages,
    summary: sortedPages.join(", "),
  };
}

function createPageCardMarkup(documentState, pageIndex, isSelected) {
  const thumbnail = documentState.thumbnails[pageIndex];
  const thumbnailMarkup = thumbnail
    ? `<img class="page-thumbnail" src="${thumbnail}" alt="Preview of page ${pageIndex + 1}" loading="lazy" />`
    : `<div class="page-thumbnail placeholder">${getThumbnailPlaceholderText(documentState.thumbnailStatus)}</div>`;

  return `${thumbnailMarkup}<strong>${pageIndex + 1}</strong><span>${isSelected ? "Included" : "Excluded"}</span>`;
}

function getThumbnailPlaceholderText(status) {
  if (status === "error") {
    return "Preview unavailable";
  }

  if (status === "ready") {
    return "No preview";
  }

  return "Rendering preview";
}

function observeVisibleThumbnails() {
  disconnectThumbnailObserver();

  if (!("IntersectionObserver" in window)) {
    state.documents.forEach((documentState) => {
      for (let pageIndex = 0; pageIndex < Math.min(documentState.pageCount, 8); pageIndex += 1) {
        void ensureThumbnailForPage(documentState.id, pageIndex);
      }
    });
    return;
  }

  state.thumbnailObserver = new IntersectionObserver(handleThumbnailIntersection, {
    root: null,
    rootMargin: VISIBLE_THUMBNAIL_ROOT_MARGIN,
    threshold: 0.01,
  });

  elements.fileList.querySelectorAll(".page-toggle").forEach((node) => {
    state.thumbnailObserver.observe(node);
  });
}

function disconnectThumbnailObserver() {
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = null;
}

function handleThumbnailIntersection(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) {
      return;
    }

    const documentId = entry.target.dataset.documentId;
    const pageIndex = Number(entry.target.dataset.pageIndex);
    void ensureThumbnailForPage(documentId, pageIndex);
    state.thumbnailObserver?.unobserve(entry.target);
  });
}

async function ensureThumbnailForPage(documentId, pageIndex) {
  const documentState = state.documents.find((candidate) => candidate.id === documentId);

  if (!documentState || Number.isNaN(pageIndex) || pageIndex < 0 || pageIndex >= documentState.pageCount) {
    return;
  }

  if (documentState.thumbnails[pageIndex] || documentState.inflightThumbnails.has(pageIndex)) {
    return;
  }

  documentState.inflightThumbnails.add(pageIndex);
  documentState.thumbnailStatus = "loading";

  try {
    const pdf = await getPdfjsDocument(documentState);
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 0.24 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create a canvas context.");
    }

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({ canvasContext: context, viewport }).promise;
    documentState.thumbnails[pageIndex] = canvas.toDataURL("image/jpeg", 0.74);
    updateThumbnailNode(documentId, pageIndex, documentState.thumbnails[pageIndex], pageIndex + 1);

    if (documentState.thumbnails.every((thumbnail) => thumbnail !== null)) {
      documentState.thumbnailStatus = "ready";
    }
  } catch (error) {
    console.error(error);
    documentState.thumbnailStatus = "error";
    scheduleRender();
  } finally {
    documentState.inflightThumbnails.delete(pageIndex);
  }
}

function getPdfjsDocument(documentState) {
  if (!documentState.pdfjsDocumentPromise) {
    const loadingTask = pdfjsLib.getDocument({ data: documentState.bytes.slice(0) });
    documentState.pdfjsDocumentPromise = loadingTask.promise;
  }

  return documentState.pdfjsDocumentPromise;
}

function updateThumbnailNode(documentId, pageIndex, thumbnailUrl, pageNumber) {
  const pageToggle = elements.fileList.querySelector(
    `.page-toggle[data-document-id="${documentId}"][data-page-index="${pageIndex}"]`,
  );

  if (!pageToggle) {
    scheduleRender();
    return;
  }

  const currentThumbnail = pageToggle.querySelector(".page-thumbnail");
  if (!currentThumbnail) {
    scheduleRender();
    return;
  }

  const image = document.createElement("img");
  image.className = "page-thumbnail";
  image.src = thumbnailUrl;
  image.alt = `Preview of page ${pageNumber}`;
  image.loading = "lazy";
  currentThumbnail.replaceWith(image);
}

function attachFileDragHandlers(fileCard, documentId) {
  fileCard.addEventListener("dragstart", (event) => {
    state.dragState.draggedDocumentId = documentId;
    state.dragState.dropTargetDocumentId = documentId;

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", documentId);
    }

    render();
  });

  fileCard.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!state.dragState.draggedDocumentId || state.dragState.draggedDocumentId === documentId) {
      return;
    }

    state.dragState.dropTargetDocumentId = documentId;
    fileCard.classList.add("is-drop-target");
  });

  fileCard.addEventListener("dragleave", () => {
    if (state.dragState.dropTargetDocumentId === documentId) {
      state.dragState.dropTargetDocumentId = null;
      render();
    }
  });

  fileCard.addEventListener("drop", (event) => {
    event.preventDefault();
    const draggedDocumentId = state.dragState.draggedDocumentId || event.dataTransfer?.getData("text/plain");
    reorderDocumentById(draggedDocumentId, documentId);
  });

  fileCard.addEventListener("dragend", () => {
    state.dragState.draggedDocumentId = null;
    state.dragState.dropTargetDocumentId = null;
    render();
  });
}

window.addEventListener("beforeunload", () => {
  disconnectThumbnailObserver();
});
