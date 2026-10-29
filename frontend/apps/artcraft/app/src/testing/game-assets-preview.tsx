import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StorytellerApiHostStore } from "@storyteller/api";
import { storeSignedSession } from "../../../../../libs/api/src/lib/ApiManager";
import GameAssets from "../pages/PageGameAssets/GameAssets";
import "../styles/tailwind.css";
import "../styles/base.css";

// Development-only host: same workspace component, authenticated against
// the real local API through Vite's /v1 proxy. No mocked assets or gates.
StorytellerApiHostStore.getInstance().setApiSchemeAndHost(window.location.origin);

function WorkspacePreview() {
  const [signedIn, setSignedIn] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/v1/session", { credentials: "include" }).then((r) => r.json()).then((r) => setSignedIn(r.logged_in === true)).catch(() => {});
  }, []);
  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const response = await fetch("/v1/login", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username_or_email: username, password }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message ?? payload.error_message ?? "登录失败，请检查本地账号。");
      if (payload.signed_session) storeSignedSession(payload.signed_session);
      setPassword(""); setSignedIn(true);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "服务暂时不可用。"); }
    finally { setBusy(false); }
  };
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#151922", color: "#edf1f8" }}>
    <div style={{ padding: "8px 18px", fontSize: 11, background: "#242b38", color: "#aebcd2" }}>开发验证宿主 · 使用真实本地服务 · 此页面不计作桌面应用验收</div>
    {signedIn ? <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}><GameAssets /></div>
      : <form onSubmit={(e) => void signIn(e)} style={{ width: 360, maxWidth: "90vw", margin: "80px auto" }}>
        <h1 style={{ fontSize: 23, marginBottom: 10 }}>登录本地工作台</h1><p style={{ marginBottom: 24, color: "#aebcd2" }}>用于验证同一个游戏资产页面的真实 API 路径。</p>
        <label className="ga-field">用户名<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label className="ga-field">密码<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p role="alert" className="ga-error">{error}</p>}
        <button className="ga-action ga-primary" disabled={busy} type="submit">{busy ? "登录中…" : "登录"}</button>
      </form>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<WorkspacePreview />);
