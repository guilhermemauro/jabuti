// Decides what the browser may show: first-run setup, login, or the app (C15).
// The server is the authority; this only mirrors /api/session.
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { App } from "./App.tsx";

type SessionState = "loading" | "setup" | "login" | "ready" | "offline";

async function fetchState(): Promise<SessionState> {
  try {
    const res = await fetch("/api/session");
    const body = (await res.json()) as { state?: SessionState };
    return body.state ?? "offline";
  } catch {
    return "offline";
  }
}

async function post(path: string, body: unknown): Promise<string | undefined> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return undefined;
    const data = (await res.json()) as { error?: string };
    return data.error ?? `Request failed (${String(res.status)}).`;
  } catch {
    return "Cannot reach the Jabuti server.";
  }
}

export function Gate() {
  const [state, setState] = useState<SessionState>("loading");
  const refresh = useCallback(() => {
    void fetchState().then(setState);
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (state !== "offline") return;
    const timer = setTimeout(refresh, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [state, refresh]);

  switch (state) {
    case "loading":
      return null;
    case "offline":
      return (
        <Panel title="Jabuti">
          <p>Cannot reach the Jabuti server. Retrying…</p>
        </Panel>
      );
    case "setup":
      return <Credentials mode="setup" onDone={refresh} />;
    case "login":
      return <Credentials mode="login" onDone={refresh} />;
    case "ready":
      return (
        <App
          onSessionCheck={refresh}
          onLogout={() => {
            void post("/api/logout", {}).then(refresh);
          }}
        />
      );
  }
}

function Credentials({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (mode === "setup" && password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    const body = mode === "setup" ? { code, password } : { password };
    void post(mode === "setup" ? "/api/setup" : "/api/login", body).then((failure) => {
      setBusy(false);
      if (failure) setError(failure);
      else onDone();
    });
  };

  return (
    <Panel title={mode === "setup" ? "Set up Jabuti" : "Log in to Jabuti"}>
      <form onSubmit={submit}>
        {mode === "setup" && (
          <>
            <p>
              Choose the owner password for this instance. The setup code is printed in the server
              log, on the line that starts with &quot;First run&quot;.
            </p>
            <label>
              Setup code
              <input
                value={code}
                autoComplete="off"
                onChange={(e) => {
                  setCode(e.target.value);
                }}
              />
            </label>
          </>
        )}
        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>
        {mode === "setup" && (
          <label>
            Confirm password
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
            />
          </label>
        )}
        {error && (
          <div className="problem" role="alert">
            {error}
          </div>
        )}
        <button className="primary" disabled={busy || !password}>
          {mode === "setup" ? "Create owner" : "Log in"}
        </button>
      </form>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gate">
      <div className="panel">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}
