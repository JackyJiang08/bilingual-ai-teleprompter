// SPDX-License-Identifier: MIT
// Part of Bilingual AI Teleprompter, a fork of openTeleprompt (MIT).
// speech-sidecar — on-device speech recognition bridge for the teleprompter.
//
// Runs Apple's SFSpeechRecognizer with requiresOnDeviceRecognition=true and
// streams partial transcripts as NDJSON on stdout. Managed as a Tauri sidecar
// by the main app; can also be run standalone for debugging:
//
//   speech-sidecar --locale en-US
//
// Protocol (one JSON object per line on stdout):
//   {"type":"ready","locale":"en-US","onDevice":true}
//   {"type":"partial","session":1,"text":"hello world"}
//   {"type":"final","session":1,"text":"hello world"}   // session then increments
//   {"type":"error","code":"...","message":"...","fatal":true|false}
//
// Fatal error codes: auth_denied, auth_restricted, locale_unavailable,
// ondevice_unsupported, audio_error, recognizer_storm.
// Non-fatal: recognizer_error (a new session is started automatically).
//
// No audio or transcript ever leaves the process except via stdout to the
// parent app; recognition is forced on-device.

import AVFoundation
import Foundation
import Speech

// ── stdout emitter ─────────────────────────────────────────
let emitQueue = DispatchQueue(label: "emit")
func emit(_ obj: [String: Any]) {
    emitQueue.sync {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

func fatalError(code: String, message: String) -> Never {
    emit(["type": "error", "code": code, "message": message, "fatal": true])
    exit(2)
}

// ── args ───────────────────────────────────────────────────
var localeId = "en-US"
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    if a == "--locale", let v = args.next() { localeId = v }
}

// ── authorization ──────────────────────────────────────────
let authSem = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .notDetermined {
    SFSpeechRecognizer.requestAuthorization { status in
        authStatus = status
        authSem.signal()
    }
    authSem.wait()
}
switch authStatus {
case .authorized: break
case .restricted: fatalError(code: "auth_restricted", message: "Speech recognition is restricted on this Mac.")
default: fatalError(code: "auth_denied", message: "Speech recognition permission was denied.")
}

// ── recognizer ─────────────────────────────────────────────
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fatalError(code: "locale_unavailable", message: "No speech recognizer for locale \(localeId).")
}
guard recognizer.supportsOnDeviceRecognition else {
    fatalError(code: "ondevice_unsupported",
               message: "On-device recognition unavailable for \(localeId). Install the dictation language in System Settings › Keyboard › Dictation.")
}

// ── recognition pipeline ───────────────────────────────────
final class Pipeline: NSObject {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let lock = NSLock()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var session = 1
    var sessionStart = Date()
    var quickFailures = 0

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        super.init()
    }

    func startAudio() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.lock.lock()
            let req = self.request
            self.lock.unlock()
            req?.append(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func startSession() {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.taskHint = .dictation
        if #available(macOS 13.0, *) {
            req.addsPunctuation = false
        }
        lock.lock()
        request = req
        lock.unlock()
        sessionStart = Date()

        let current = session
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                let segments = result.bestTranscription.segments
                let confidence = segments.isEmpty
                    ? 0.0
                    : segments.map { Double($0.confidence) }.reduce(0, +) / Double(segments.count)
                if result.isFinal {
                    emit(["type": "final", "session": current, "text": text, "confidence": confidence])
                    self.rotateSession()
                } else {
                    emit(["type": "partial", "session": current, "text": text, "confidence": confidence])
                }
            } else if let error = error {
                let elapsed = Date().timeIntervalSince(self.sessionStart)
                if elapsed < 2.0 {
                    self.quickFailures += 1
                } else {
                    self.quickFailures = 0
                }
                if self.quickFailures >= 3 {
                    fatalError(code: "recognizer_storm",
                               message: "Recognition keeps failing: \(error.localizedDescription)")
                }
                emit(["type": "error", "code": "recognizer_error",
                      "message": error.localizedDescription, "fatal": false])
                self.rotateSession()
            }
        }
    }

    private func rotateSession() {
        lock.lock()
        request?.endAudio()
        request = nil
        lock.unlock()
        task?.cancel()
        task = nil
        session += 1
        // Small delay so a failing recognizer can't spin the CPU.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.startSession()
        }
    }
}

let pipeline = Pipeline(recognizer: recognizer)
do {
    try pipeline.startAudio()
} catch {
    fatalError(code: "audio_error", message: "Could not start audio capture: \(error.localizedDescription)")
}
pipeline.startSession()

emit(["type": "ready", "locale": localeId, "onDevice": true])

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

RunLoop.main.run()
