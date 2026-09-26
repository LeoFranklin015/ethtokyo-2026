"use client";

import { useEffect, useState } from "react";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type ProviderDetail = {
  info: ProviderInfo;
  provider: Eip1193Provider;
};

export default function WalletDemoPage() {
  const [providers, setProviders] = useState<ProviderDetail[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    function onAnnounce(event: Event) {
      const detail = (event as CustomEvent<ProviderDetail>).detail;
      setProviders((prev) => {
        if (prev.some((p) => p.info.uuid === detail.info.uuid)) return prev;
        return [...prev, detail];
      });
    }

    window.addEventListener("eip6963:announceProvider", onAnnounce);

    // Inject the served provider script.
    const script = document.createElement("script");
    script.src = "/wallet/provider.js";
    script.async = true;
    document.body.appendChild(script);

    // Ask any already-loaded providers to announce (covers the race where the
    // provider loaded before this listener was attached).
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, []);

  async function connect(detail: ProviderDetail) {
    setStatus("Requesting accounts…");
    try {
      const accounts = (await detail.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (accounts.length > 0) {
        setAccount(accounts[0]);
        setStatus("Connected.");
      } else {
        setAccount(null);
        setStatus("No account (empty array — expected until the account endpoint exists).");
      }
    } catch (err) {
      setStatus("Error: " + JSON.stringify(err));
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>VLAN Read-Only Wallet — EIP-6963 demo</h1>
      <p>
        Discovered providers are announced via <code>eip6963:announceProvider</code>. Click one to
        call <code>eth_requestAccounts</code>. An empty account array is expected until the account
        endpoint (Task 5) is live.
      </p>

      <h2>Discovered providers</h2>
      {providers.length === 0 ? (
        <p>No providers announced yet…</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {providers.map((p) => (
            <li key={p.info.uuid} style={{ marginBottom: 12 }}>
              <button
                onClick={() => connect(p)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  border: "1px solid #ccc",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: "transparent",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.info.icon} alt="" width={28} height={28} />
                <span>
                  <strong>{p.info.name}</strong>
                  <br />
                  <small>{p.info.rdns}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2>Account</h2>
      <p>{account ? <code>{account}</code> : "—"}</p>
      <p>
        <em>{status}</em>
      </p>
    </main>
  );
}
