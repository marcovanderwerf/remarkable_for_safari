import Cocoa
import SafariServices

class ViewController: NSViewController {

    @IBOutlet weak var statusLabel: NSTextField!
    @IBOutlet weak var openSafariButton: NSButton!

    override func viewDidLoad() {
        super.viewDidLoad()

        updateExtensionStatus()
    }

    override var representedObject: Any? {
        didSet {
            // Update the view, if already loaded.
        }
    }

    func updateExtensionStatus() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: getExtensionBundleIdentifier()) { state, error in
            DispatchQueue.main.async {
                if let error = error {
                    self.statusLabel.stringValue = "Error checking extension status: \(error.localizedDescription)"
                    return
                }

                guard let state = state else {
                    self.statusLabel.stringValue = "Unable to determine extension status."
                    return
                }

                if state.isEnabled {
                    self.statusLabel.stringValue = "✓ Extension is enabled in Safari"
                    self.statusLabel.textColor = NSColor.systemGreen
                } else {
                    self.statusLabel.stringValue = "Extension is not enabled. Open Safari preferences to enable it."
                    self.statusLabel.textColor = NSColor.secondaryLabelColor
                }
            }
        }
    }

    @IBAction func openSafariPreferences(_ sender: Any) {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: getExtensionBundleIdentifier()) { error in
            if let error = error {
                NSLog("Error opening Safari preferences: \(error.localizedDescription)")
            }
        }
    }

    func getExtensionBundleIdentifier() -> String {
        // Get the bundle identifier of the extension
        // The extension bundle ID is the app bundle ID + ".Extension"
        let bundleId = Bundle.main.bundleIdentifier ?? "com.remarkable.safari"
        return bundleId + ".Extension"
    }
}
