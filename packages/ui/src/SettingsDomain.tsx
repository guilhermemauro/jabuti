// The instance's public domain (deploy/). A server set up from deploy/ answers first on
// its sslip.io name; the owner points a domain of their own at it and saves it here.
// The server checks the domain resolves to the address this page is on before saving.
import type { ClientMessage } from "@jabuti/protocol";
import { useState } from "react";

type Send = (message: ClientMessage) => void;

const SSLIP = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/;

export function Domain(props: { domain: string | null; send: Send }) {
  const { domain, send } = props;
  const [name, setName] = useState(domain ?? "");
  const here = window.location.hostname;
  const ip = SSLIP.exec(here)?.slice(1).join(".");
  const typed = name.trim().toLowerCase();
  return (
    <div className="memory-files notes">
      <p className="sub">
        On a server, Jabuti answers on a free sslip.io name made from its IP, with HTTPS. Give it a
        domain of your own so the address does not depend on that service or on the IP: you open
        Jabuti on the domain, and MCP logins return there.
      </p>
      <fieldset>
        <legend>Domain</legend>
        <p>
          {domain ? (
            <>
              Jabuti answers on{" "}
              <a href={`https://${domain}`} className="mono">
                https://{domain}
              </a>
              {ip && " and still on this sslip.io name"}.
            </>
          ) : (
            <>No domain yet: Jabuti answers on {here}.</>
          )}
        </p>
        <ol className="sub">
          <li>
            At your DNS provider, create an <span className="mono">A</span> record for the name you
            want, such as <span className="mono">jabuti.example.com</span>, pointing to{" "}
            <span className="mono">{ip ?? "this server's IP"}</span>.
          </li>
          <li>Wait a few minutes for it to spread, then save it below.</li>
          <li>
            Open it. The certificate is issued on the first visit, which takes a few seconds, and
            you log in again there. If an MCP server uses an OAuth login, log in to it again from
            the new address.
          </li>
        </ol>
        <div className="row">
          <input
            type="text"
            aria-label="Domain"
            placeholder="jabuti.example.com"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <button
            className="primary"
            disabled={typed === "" || typed === domain}
            onClick={() => {
              send({ type: "domain.save", domain: typed });
            }}
          >
            Check and save
          </button>
          {domain && (
            <button
              onClick={() => {
                if (confirm(`Stop answering on ${domain}?`)) {
                  send({ type: "domain.save", domain: null });
                  setName("");
                }
              }}
            >
              Remove
            </button>
          )}
        </div>
      </fieldset>
    </div>
  );
}
