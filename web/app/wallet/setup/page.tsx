import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Install the VLAN Wallet Root CA",
  description:
    "One-time per-device steps to trust the VLAN wallet root certificate authority so the read-only wallet reaches cold third-party dapps.",
};

export default function WalletSetupPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", lineHeight: 1.55 }}>
      <h1>Install the VLAN wallet root certificate</h1>

      <p>
        This is a <strong>one-time manual operation you perform once per device, inside the operating
        system</strong>. There is <strong>no browser button, extension, or JavaScript API</strong> that can do
        it for you — trusting a root certificate authority is deliberately a manual OS-level action.
      </p>
      <p>
        Until you complete these steps, the read-only wallet appears <strong>only</strong> in pages served
        through the VLAN portal (Layer 1). To have the wallet appear in <strong>cold</strong> third-party dapps
        that you open directly — pages the VLAN host TLS-intercepts to inject the provider script (Layer 2) —
        the device must trust this root CA first.
      </p>

      <p>
        <a href="/wallet/ca.crt" download>
          Download the root CA certificate (ca.crt)
        </a>
      </p>

      <hr />

      <section>
        <h2>iOS / iPadOS</h2>
        <p>
          <strong>Both steps below are required.</strong> Installing the profile alone does <strong>not</strong>{" "}
          trust the certificate — you must also enable full trust in Certificate Trust Settings.
        </p>
        <ol>
          <li>Download the CA profile (the ca.crt link above) on the device.</li>
          <li>Open <strong>Settings → General → VPN &amp; Device Management</strong> and install the downloaded profile.</li>
          <li>
            Then open <strong>Settings → General → About → Certificate Trust Settings</strong> and toggle{" "}
            <strong>full trust on</strong> for this root certificate.
          </li>
        </ol>
        <p>Without the second toggle, iOS installs the certificate but does not trust it for TLS.</p>
      </section>

      <section>
        <h2>Android</h2>
        <ol>
          <li>Download the CA (the ca.crt link above) on the device.</li>
          <li>
            Open <strong>Settings → Security</strong> and install it as a <strong>CA certificate</strong> (this
            adds it to the <strong>user CA store</strong>).
          </li>
        </ol>
        <p>
          <strong>Caveats:</strong> the injected wallet works in <strong>Chrome only</strong>, not in native
          WebViews, and <strong>some apps ignore user CAs</strong> entirely (they trust only the system CA store).
          Those apps will not see the wallet even after this step.
        </p>
      </section>

      <section>
        <h2>macOS</h2>
        <ol>
          <li>Download the CA (the ca.crt link above).</li>
          <li>
            Open it in <strong>Keychain Access</strong> and add it to the <strong>System keychain</strong>.
          </li>
          <li>
            Double-click the certificate, expand <strong>Trust</strong>, and set it to <strong>Always Trust</strong>.
          </li>
        </ol>
      </section>

      <section>
        <h2>Windows</h2>
        <ol>
          <li>Download the CA (the ca.crt link above).</li>
          <li>
            Open the Certificate Manager (<strong>certmgr</strong>).
          </li>
          <li>
            Import the certificate into <strong>Trusted Root Certification Authorities</strong>.
          </li>
        </ol>
      </section>
    </main>
  );
}
