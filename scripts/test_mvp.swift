import AppKit
import Foundation
import WebKit

final class NavigationDelegate: NSObject, WKNavigationDelegate {
    var onFinish: (() -> Void)?
    var onError: ((Error) -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onFinish?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onError?(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onError?(error)
    }
}

final class TestRunner {
    private let webView: WKWebView
    private let delegate = NavigationDelegate()
    private var isFinished = false
    private var loadError: Error?
    private var resultError: Error?
    private var mergedBase64: String?
    private var snapshotJSON: String?

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView.setValue(false, forKey: "drawsBackground")
        self.webView.navigationDelegate = delegate
        self.delegate.onFinish = { [weak self] in
            self?.runScenario()
        }
        self.delegate.onError = { [weak self] error in
            self?.loadError = error
            self?.isFinished = true
        }
    }

    func start(url: URL) {
        webView.load(URLRequest(url: url))
        let timeoutDate = Date().addingTimeInterval(60)
        while !isFinished && RunLoop.main.run(mode: .default, before: timeoutDate) {}

        if !isFinished && loadError == nil && resultError == nil {
            loadError = NSError(domain: "OnePDFTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for web test to finish"])
        }
    }

    func finish() throws {
        if let loadError {
            throw loadError
        }

        if let resultError {
            throw resultError
        }

        guard let mergedBase64 else {
            throw NSError(domain: "OnePDFTest", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing merged PDF output"])
        }

        let outputURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("tests/results/merged-output.pdf")
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = Data(base64Encoded: mergedBase64) else {
            throw NSError(domain: "OnePDFTest", code: 3, userInfo: [NSLocalizedDescriptionKey: "Merged PDF base64 decode failed"])
        }

        try data.write(to: outputURL)
        if let snapshotJSON {
            print(snapshotJSON)
        }
        print(outputURL.path)
    }

    private func runScenario() {
        let script = """
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const originalCreate = URL.createObjectURL.bind(URL);
        const originalRevoke = URL.revokeObjectURL.bind(URL);
        const originalClick = HTMLAnchorElement.prototype.click;
        let capturedBlob = null;
        let capturedDownloadName = null;

        URL.createObjectURL = (blob) => {
          capturedBlob = blob;
          return originalCreate(blob);
        };

        URL.revokeObjectURL = () => {};
        HTMLAnchorElement.prototype.click = function () {
          capturedDownloadName = this.download;
          return originalClick.call(this);
        };

        const paths = ["./tests/fixtures/sample-a.pdf", "./tests/fixtures/sample-b.pdf"];
        const blobs = await Promise.all(paths.map((path) => fetch(path).then((response) => response.blob())));
        const files = blobs.map((blob, index) => new File([blob], index === 0 ? "sample-a.pdf" : "sample-b.pdf", { type: "application/pdf" }));

        await window.onePdfApp.handleFiles(files);

        for (let attempt = 0; attempt < 40; attempt += 1) {
          const thumbnailCount = document.querySelectorAll('.page-thumbnail').length;
          if (thumbnailCount >= 5) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (document.querySelectorAll('.page-thumbnail').length < 5) {
          throw new Error('Expected page thumbnails to be rendered before export');
        }

        const fileCards = Array.from(document.querySelectorAll('.file-card'));
        if (fileCards.length < 2) {
          throw new Error('Expected at least two file cards for reorder testing');
        }

        const draggedDocumentId = fileCards[1].dataset.documentId;
        const targetDocumentId = fileCards[0].dataset.documentId;
        window.onePdfApp.reorderDocumentById(draggedDocumentId, targetDocumentId);

        const exportNameAfterReorder = document.querySelector('#export-filename')?.value;
        if (exportNameAfterReorder !== 'sample-b-merged') {
          throw new Error(`Expected suggested export name to follow reordered first file, got ${exportNameAfterReorder}`);
        }

        const includeInput = document.querySelector('.file-card .include-range-input');
        includeInput.value = '1';
        includeInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.file-card .apply-include').click();

        const excludeInput = document.querySelectorAll('.exclude-range-input')[1];
        excludeInput.value = '2';
        excludeInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelectorAll('.apply-exclude')[1].click();

        const manualFilenameInput = document.querySelector('#export-filename');
        manualFilenameInput.value = 'Paid_Applications_v120.pdf';
        manualFilenameInput.dispatchEvent(new Event('input', { bubbles: true }));

        const exportDetails = document.querySelector('#export-details')?.textContent ?? '';
        if (!exportDetails.includes('Paid_Applications_v120.pdf') || exportDetails.includes('.pdf.pdf')) {
          throw new Error(`Expected normalized export filename in summary, got: ${exportDetails}`);
        }

        await window.onePdfApp.exportMergedPdf();

        if (capturedDownloadName !== 'Paid_Applications_v120.pdf') {
          throw new Error(`Expected captured download filename to be normalized, got: ${capturedDownloadName}`);
        }

        if (!capturedBlob) {
          throw new Error('Merged PDF blob was not captured');
        }

        const arrayBuffer = await capturedBlob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(arrayBuffer));
        let binary = '';
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }

        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
        HTMLAnchorElement.prototype.click = originalClick;

        return {
          state: window.onePdfApp.getStateSnapshot(),
          thumbnailCount: document.querySelectorAll('.page-thumbnail').length,
          exportFilename: document.querySelector('#export-filename')?.value,
          capturedDownloadName,
          exportDetails: document.querySelector('#export-details')?.textContent,
          mergedBase64: btoa(binary),
        };
        """

        evaluate(script) { [weak self] result in
            switch result {
            case .success(let value):
                let payload: [String: Any]?

                if let dictionary = value as? [String: Any] {
                    payload = dictionary
                } else if let stringValue = value as? String,
                          let data = stringValue.data(using: .utf8),
                          let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    payload = dictionary
                } else {
                    payload = nil
                }

                guard let payload,
                      let mergedBase64 = payload["mergedBase64"] as? String else {
                    self?.resultError = NSError(domain: "OnePDFTest", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unexpected JS payload: \(String(describing: value))"])
                    self?.isFinished = true
                    return
                }

                self?.mergedBase64 = mergedBase64
                if let state = payload["state"],
                   let stateData = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted]),
                   let stateString = String(data: stateData, encoding: .utf8) {
                    self?.snapshotJSON = stateString
                }
                self?.isFinished = true
            case .failure(let error):
                self?.resultError = error
                self?.isFinished = true
            }
        }
    }

    private func evaluate(_ script: String, completion: @escaping (Result<Any?, Error>) -> Void) {
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                completion(.success(value))
            case .failure(let error):
                completion(.failure(error))
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

guard CommandLine.arguments.count > 1,
      let url = URL(string: CommandLine.arguments[1]) else {
    fputs("Usage: swift scripts/test_mvp.swift <url>\n", stderr)
    exit(1)
}

let runner = TestRunner()
runner.start(url: url)

do {
    try runner.finish()
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
