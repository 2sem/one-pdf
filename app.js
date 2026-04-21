import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs";

const elements = {
  fileInput: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  editorDropzone: document.querySelector("#editor-dropzone"),
  fileList: document.querySelector("#file-list"),
  mergeButton: document.querySelector("#merge-button"),
  resetButton: document.querySelector("#reset-button"),
  feedback: document.querySelector("#feedback"),
  fileCount: document.querySelector("#file-count"),
  selectedPages: document.querySelector("#selected-pages"),
  exportSummary: document.querySelector("#export-summary"),
  exportBar: document.querySelector("#export-bar"),
  exportFilename: document.querySelector("#export-filename"),
  appShell: document.querySelector("#app-shell"),
  workspace: document.querySelector("#workspace"),
  editorPanel: document.querySelector("#editor-panel"),
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
    dropPosition: null,
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
elements.exportFilename.addEventListener("blur", () => {
  normalizeExportFilenameField();
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
      includeRangeDraft: documentState.includeRangeDraft,
      excludeRangeDraft: documentState.excludeRangeDraft,
    })),
};

function setupDropzone() {
  const preventDefaults = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  setupFileDropTarget(elements.dropzone, {
    onDragStateChange: (isDragging) => {
      elements.dropzone.classList.toggle("is-dragging", isDragging);
    },
  });

  setupFileDropTarget(elements.editorDropzone, {
    onDragStateChange: (isDragging) => {
      elements.editorDropzone.classList.toggle("is-dragging", isDragging);
    },
  });

  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  elements.editorDropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
}

function setupFileDropTarget(target, { onDragStateChange }) {
  const preventDefaults = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    target.addEventListener(eventName, preventDefaults);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    target.addEventListener(eventName, () => {
      onDragStateChange(true);
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    target.addEventListener(eventName, () => {
      onDragStateChange(false);
    });
  });

  target.addEventListener("drop", (event) => {
    void handleFiles(event.dataTransfer?.files);
  });
}

async function handleFiles(fileList) {
  const hadDocumentsBefore = state.documents.length > 0;
  const files = Array.from(fileList ?? []).filter(isPdfFile);

  if (!files.length) {
    setFeedback("Please choose at least one valid PDF file.");
    elements.sessionStatus.textContent = "Waiting";
    return;
  }

  elements.sessionStatus.textContent = "Loading";
  setFeedback("");

  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const pdf = await PDFDocument.load(bytes);
      const pageCount = pdf.getPageCount();

      state.documents.push({
        id: createDocumentId(),
        name: getNormalizedPdfDisplayName(file.name),
        size: file.size,
        bytes,
        pageCount,
        selections: Array(pageCount).fill(true),
        includeRangeDraft: "",
        excludeRangeDraft: "",
        thumbnails: Array(pageCount).fill(null),
        thumbnailPromises: new Map(),
        thumbnailStatus: "idle",
        pdfjsDocumentPromise: null,
        largePreviewOpen: false,
        largePreviewPageIndex: 0,
        largePreviewStatus: "idle",
        largePreviewDataUrl: null,
        largePreviewPromise: null,
        largePreviewRenderToken: 0,
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
    setFeedback("");

    if (!hadDocumentsBefore) {
      focusEditorPanel();
    }
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
  state.dragState.dropPosition = null;
  disconnectThumbnailObserver();
  setFeedback("");
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
  elements.mergeButton.textContent = state.exporting ? "Exporting..." : "Export PDF";
  renderEditorState();
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
      if (state.dragState.dropPosition) {
        fileCard.classList.add(`drop-${state.dragState.dropPosition}`);
      }
    }

    attachFileDragHandlers(fileCard, documentState.id);

    fileCard.querySelector(".file-name").textContent = documentState.name;
    fileCard.querySelector(".file-order-hint").textContent = "";
    fileCard.querySelector(".file-meta").textContent = `${documentState.pageCount}p`;
    fileCard.querySelector(".drag-handle").title = state.documents.length > 1
      ? `Drag to reorder file ${index + 1}`
      : "Add another PDF to enable reordering";
    fileCard.querySelector(".drag-handle").setAttribute(
      "aria-label",
      state.documents.length > 1 ? `Drag to reorder file ${index + 1}` : "Add another PDF to enable reordering",
    );
    const includeRangeInput = fileCard.querySelector(".include-range-input");
    const excludeRangeInput = fileCard.querySelector(".exclude-range-input");
    const largePreviewPanel = fileCard.querySelector(".large-preview-panel");
    const largePreviewToggle = fileCard.querySelector(".large-preview-summary");
    const largePreviewMeta = fileCard.querySelector(".large-preview-meta");
    const largePreviewFrame = fileCard.querySelector(".large-preview-frame");
    const largePreviewImage = fileCard.querySelector(".large-preview-image");
    const largePreviewPlaceholder = fileCard.querySelector(".large-preview-placeholder");
    const largePreviewPrev = fileCard.querySelector(".preview-prev");
    const largePreviewNext = fileCard.querySelector(".preview-next");
    const largePreviewStatus = fileCard.querySelector(".large-preview-status");
    const largePreviewToggleSelection = fileCard.querySelector(".preview-toggle-selection");
    includeRangeInput.value = documentState.includeRangeDraft;
    excludeRangeInput.value = documentState.excludeRangeDraft;
    largePreviewPanel.classList.toggle("is-open", documentState.largePreviewOpen);
    largePreviewFrame.hidden = !documentState.largePreviewOpen;
    largePreviewToggle.textContent = documentState.largePreviewOpen
      ? `Hide preview • p${documentState.largePreviewPageIndex + 1}`
      : `Preview • p${documentState.largePreviewPageIndex + 1}`;
    largePreviewMeta.textContent = `Page ${documentState.largePreviewPageIndex + 1} of ${documentState.pageCount}`;
    largePreviewPrev.disabled = documentState.largePreviewPageIndex === 0;
    largePreviewNext.disabled = documentState.largePreviewPageIndex === documentState.pageCount - 1;
    const previewSelection = documentState.selections[documentState.largePreviewPageIndex];
    largePreviewStatus.textContent = previewSelection ? "Included" : "Excluded";
    largePreviewToggleSelection.textContent = previewSelection ? "Exclude" : "Include";
    updateLargePreviewPanel(documentState, largePreviewImage, largePreviewPlaceholder, largePreviewMeta, largePreviewFrame);
    largePreviewToggle.addEventListener("click", () => {
      documentState.largePreviewOpen = !documentState.largePreviewOpen;
      if (documentState.largePreviewOpen) {
        void ensureLargePreview(documentState);
      }
      render();
    });
    largePreviewPanel.addEventListener("keydown", (event) => {
      if (!documentState.largePreviewOpen) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setLargePreviewPage(documentState, Math.max(0, documentState.largePreviewPageIndex - 1));
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        setLargePreviewPage(documentState, Math.min(documentState.pageCount - 1, documentState.largePreviewPageIndex + 1));
      }

      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        documentState.selections[documentState.largePreviewPageIndex] = !documentState.selections[documentState.largePreviewPageIndex];
        render();
      }
    });
    largePreviewPrev.addEventListener("click", () => {
      setLargePreviewPage(documentState, Math.max(0, documentState.largePreviewPageIndex - 1));
    });
    largePreviewNext.addEventListener("click", () => {
      setLargePreviewPage(documentState, Math.min(documentState.pageCount - 1, documentState.largePreviewPageIndex + 1));
    });
    largePreviewToggleSelection.addEventListener("click", () => {
      documentState.selections[documentState.largePreviewPageIndex] = !documentState.selections[documentState.largePreviewPageIndex];
      render();
    });
    includeRangeInput.addEventListener("input", () => {
      documentState.includeRangeDraft = includeRangeInput.value;
    });
    excludeRangeInput.addEventListener("input", () => {
      documentState.excludeRangeDraft = excludeRangeInput.value;
    });

    const moveUpButton = fileCard.querySelector(".move-up");
    const moveDownButton = fileCard.querySelector(".move-down");
    moveUpButton.disabled = index === 0;
    moveDownButton.disabled = index === state.documents.length - 1;
    moveUpButton.hidden = index === 0;
    moveDownButton.hidden = index === state.documents.length - 1;
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
      applyRangeSelection(index, documentState.includeRangeDraft, "include");
    });

    fileCard.querySelector(".apply-exclude").addEventListener("click", () => {
      applyRangeSelection(index, documentState.excludeRangeDraft, "exclude");
    });

    const pageGrid = fileCard.querySelector(".page-grid");

    documentState.selections.forEach((isSelected, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "page-toggle";
      if (documentState.largePreviewPageIndex === index) {
        wrapper.classList.add("is-preview-page");
      }
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
      label.addEventListener("click", () => {
        setLargePreviewPage(documentState, index);
      });

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

function renderEditorState() {
  elements.appShell.classList.toggle("editor-active", state.documents.length > 0);
}

function focusEditorPanel() {
  window.requestAnimationFrame(() => {
    elements.editorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function exportMergedPdf() {
  const selectedCount = getSelectedPageCount();
  normalizeExportFilenameField();
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

  if (elements.exportFilename.value !== state.exportFilename) {
    elements.exportFilename.value = state.exportFilename;
  }
  elements.exportSummary.textContent = `${selectedPages} ${selectedPages === 1 ? "page" : "pages"}`;
}

function normalizeExportFilenameField() {
  state.exportFilename = getNormalizedExportFilename();
  state.exportFilenameTouched = true;

  if (elements.exportFilename.value !== state.exportFilename) {
    elements.exportFilename.value = state.exportFilename;
  }
}

function renderSelectionSummary() {
  const selectedFiles = getSelectedFileCount();
  const selectedPages = getSelectedPageCount();

  elements.summaryTotalFiles.textContent = String(state.documents.length);
  elements.summarySelectedFiles.textContent = String(selectedFiles);
  elements.summarySelectedPages.textContent = String(selectedPages);
  elements.summaryFileList.replaceChildren();

  if (!state.documents.length) {
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
  const baseNameWithoutPdfSuffix = getNormalizedPdfBaseName(trimmed);
  const safeBaseName = baseNameWithoutPdfSuffix
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

  const originalName = getNormalizedPdfBaseName(firstDocument.name);
  return `${originalName}-merged`;
}

function getNormalizedPdfDisplayName(fileName) {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "document.pdf";
  }

  if (!/\.pdf(?:\.pdf)+$/i.test(trimmed)) {
    return trimmed;
  }

  return `${getNormalizedPdfBaseName(trimmed)}.pdf`;
}

function getNormalizedPdfBaseName(fileName) {
  return fileName.trim().replace(/(?:\.pdf)+$/i, "");
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
  state.dragState.dropPosition = null;
  setFeedback(`Order updated. ${movedDocument.name} is now file ${toIndex + 1} in the merge.`);
  render();
}

function reorderDocumentById(draggedDocumentId, targetDocumentId, dropPosition = "before") {
  if (!draggedDocumentId || !targetDocumentId || draggedDocumentId === targetDocumentId) {
    return;
  }

  const fromIndex = state.documents.findIndex((documentState) => documentState.id === draggedDocumentId);
  const targetIndex = state.documents.findIndex((documentState) => documentState.id === targetDocumentId);

  if (fromIndex === -1 || targetIndex === -1) {
    return;
  }

  let toIndex = targetIndex;
  if (dropPosition === "after") {
    toIndex = targetIndex + (fromIndex < targetIndex ? 0 : 1);
  } else if (fromIndex < targetIndex) {
    toIndex = targetIndex - 1;
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
    documentState.includeRangeDraft = normalizedRange;
  } else {
    documentState.selections = documentState.selections.map((isSelected, index) => (
      pageIndexes.has(index) ? false : isSelected
    ));
    setFeedback(`Excluded range ${parsedPages.summary} from ${documentState.name}.`);
    documentState.excludeRangeDraft = normalizedRange;
  }

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
  const previewBadge = documentState.largePreviewPageIndex === pageIndex
    ? '<span class="page-preview-badge">Preview</span>'
    : "";
  const thumbnailMarkup = thumbnail
    ? `<img class="page-thumbnail" src="${thumbnail}" alt="Preview of page ${pageIndex + 1}" loading="lazy" />`
    : `<div class="page-thumbnail placeholder">${getThumbnailPlaceholderText(documentState.thumbnailStatus)}</div>`;

  return `${previewBadge}${thumbnailMarkup}<strong>${pageIndex + 1}</strong><span>${isSelected ? "Included" : "Excluded"}</span>`;
}

function setLargePreviewPage(documentState, pageIndex) {
  documentState.largePreviewPageIndex = pageIndex;
  documentState.largePreviewDataUrl = null;
  documentState.largePreviewPromise = null;
  documentState.largePreviewRenderToken += 1;
  documentState.largePreviewOpen = true;

  void ensureLargePreview(documentState);
  focusPreviewedThumbnail(documentState.id, pageIndex);

  scheduleRender();
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

  if (documentState.thumbnails[pageIndex]) {
    return;
  }

  const existingPromise = documentState.thumbnailPromises.get(pageIndex);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const thumbnailPromise = (async () => {
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
      documentState.thumbnailPromises.delete(pageIndex);
    }
  })();

  documentState.thumbnailPromises.set(pageIndex, thumbnailPromise);
  await thumbnailPromise;
}

async function ensureLargePreview(documentState) {
  if (!documentState.largePreviewOpen) {
    return;
  }

   const existingPromise = documentState.largePreviewPromise;
   if (existingPromise) {
    await existingPromise;
    return;
   }

  const renderToken = ++documentState.largePreviewRenderToken;
  documentState.largePreviewStatus = "loading";
  scheduleRender();

  const largePreviewPromise = (async () => {
    try {
      const pdf = await getPdfjsDocument(documentState);
      const page = await pdf.getPage(documentState.largePreviewPageIndex + 1);
      const viewport = page.getViewport({ scale: 0.9 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Could not create a canvas context.");
      }

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      await page.render({ canvasContext: context, viewport }).promise;

      if (renderToken !== documentState.largePreviewRenderToken) {
        return;
      }

      documentState.largePreviewDataUrl = canvas.toDataURL("image/jpeg", 0.86);
      documentState.largePreviewStatus = "ready";
      scheduleRender();
    } catch (error) {
      console.error(error);
      documentState.largePreviewStatus = "error";
      scheduleRender();
    } finally {
      if (documentState.largePreviewPromise === largePreviewPromise) {
        documentState.largePreviewPromise = null;
      }
    }
  })();

  documentState.largePreviewPromise = largePreviewPromise;
  await largePreviewPromise;
}

function updateLargePreviewPanel(documentState, imageElement, placeholderElement, metaElement, frameElement) {
  metaElement.textContent = `Page ${documentState.largePreviewPageIndex + 1} of ${documentState.pageCount}`;
  frameElement.hidden = !documentState.largePreviewOpen;

  if (!documentState.largePreviewOpen) {
    imageElement.hidden = true;
    placeholderElement.hidden = false;
    placeholderElement.textContent = "Select a page to preview it larger.";
    return;
  }

  const previewSource = documentState.largePreviewDataUrl || documentState.thumbnails[documentState.largePreviewPageIndex];

  if (previewSource) {
    imageElement.hidden = false;
    imageElement.src = previewSource;
    imageElement.alt = `Large preview of page ${documentState.largePreviewPageIndex + 1}`;
    placeholderElement.hidden = true;
    return;
  }

  imageElement.hidden = true;
  placeholderElement.hidden = false;
  placeholderElement.textContent = documentState.largePreviewStatus === "error"
    ? "Large preview unavailable."
    : "Rendering larger preview...";

  if (documentState.largePreviewStatus !== "loading") {
    void ensureLargePreview(documentState);
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

function focusPreviewedThumbnail(documentId, pageIndex) {
  window.requestAnimationFrame(() => {
    const pageToggle = elements.fileList.querySelector(
      `.page-toggle[data-document-id="${documentId}"][data-page-index="${pageIndex}"]`,
    );

    pageToggle?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
}

function attachFileDragHandlers(fileCard, documentId) {
  fileCard.addEventListener("dragstart", (event) => {
    state.dragState.draggedDocumentId = documentId;
    state.dragState.dropTargetDocumentId = documentId;
    state.dragState.dropPosition = null;

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

    const bounds = fileCard.getBoundingClientRect();
    const midpoint = bounds.top + bounds.height / 2;
    state.dragState.dropPosition = event.clientY < midpoint ? "before" : "after";
    state.dragState.dropTargetDocumentId = documentId;
    fileCard.classList.add("is-drop-target");
  });

  fileCard.addEventListener("dragleave", () => {
    if (state.dragState.dropTargetDocumentId === documentId) {
      state.dragState.dropTargetDocumentId = null;
      state.dragState.dropPosition = null;
      render();
    }
  });

  fileCard.addEventListener("drop", (event) => {
    event.preventDefault();
    const draggedDocumentId = state.dragState.draggedDocumentId || event.dataTransfer?.getData("text/plain");
    reorderDocumentById(draggedDocumentId, documentId, state.dragState.dropPosition);
  });

  fileCard.addEventListener("dragend", () => {
    state.dragState.draggedDocumentId = null;
    state.dragState.dropTargetDocumentId = null;
    state.dragState.dropPosition = null;
    render();
  });
}

window.addEventListener("beforeunload", () => {
  disconnectThumbnailObserver();
});
