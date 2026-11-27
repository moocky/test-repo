import AVFoundation
import ExpoModulesCore

public final class AudioRouteModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("AudioRoute")

    Events("onChange")

    Function("getCurrentRoute") { () -> [String: Any] in
      return Self.currentRoute()
    }

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onChange", Self.currentRoute().mapValues { Optional($0) })
      }
    }

    OnStopObserving {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
        self.observer = nil
      }
    }
  }

  /// Headphone-like outputs: sound does not leak back into the phone's microphone.
  private static func kind(of port: AVAudioSession.Port) -> String? {
    switch port {
    case .headphones:
      return "wired"
    case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
      return "bluetooth"
    case .usbAudio:
      return "usb"
    default:
      return nil
    }
  }

  private static func currentRoute() -> [String: Any] {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    for output in outputs {
      if let kind = kind(of: output.portType) {
        return ["headphones": true, "type": kind, "name": output.portName]
      }
    }
    return ["headphones": false, "type": "speaker", "name": outputs.first?.portName ?? ""]
  }
}
