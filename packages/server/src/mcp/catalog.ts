// The MCP connectors this harness can start. An agent lists the ones it uses in
// its profile (`mcp`); each needs variables from that agent's scope (C16), which
// only the connector's process receives.
import { join } from "node:path";
import type { ConnectorInfo } from "@jabuti/protocol";

export interface ConnectorSpec extends ConnectorInfo {
  command: string;
  args: string[];
  /** Fixed, non-secret settings, such as an endpoint override in tests. */
  env?: Record<string, string>;
  /**
   * A folder the connector keeps for each agent, shared by connectors naming the same one
   * (the image history): JABUTI_STATE_DIR in its environment.
   */
  state?: string;
}

const PACKAGES = join(import.meta.dirname, "../../..");

export const CONNECTORS: ConnectorSpec[] = [
  {
    name: "serper",
    description: "Google search results (rankings, People Also Ask, news) through serper.dev.",
    variables: ["SERPER_API_KEY"],
    help: {
      SERPER_API_KEY:
        "Sign up at https://serper.dev and copy the API key shown on its dashboard. It starts with free credits; each search spends one.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-serper/src/index.ts")],
  },
  {
    name: "gsc",
    description:
      "Google Search Console, read-only: clicks, impressions, CTR and position as CSV files " +
      "in the workspace, URL index status, sitemaps.",
    variables: ["GSC_SERVICE_ACCOUNT"],
    help: {
      GSC_SERVICE_ACCOUNT:
        "In https://console.cloud.google.com, create a service account, add a JSON key to it and paste the whole JSON file here. Then, in Search Console → Settings → Users and permissions, add the client_email from that file as a Restricted user.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-gsc/src/index.ts")],
  },
  {
    name: "pagespeed",
    description:
      "Google PageSpeed Insights: Lighthouse scores, Core Web Vitals in the lab and from " +
      "real Chrome users, and what would make a public page faster.",
    variables: ["PAGESPEED_API_KEY"],
    help: {
      PAGESPEED_API_KEY:
        "In https://console.cloud.google.com, enable the PageSpeed Insights API, then go to Credentials → Create credentials → API key. Restrict the key to that API. Free within Google's quota.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-pagespeed/src/index.ts")],
  },
  {
    name: "wikipedia",
    description:
      "Wikipedia's public metrics, free: the most read articles of a day " +
      "or month, an article's views over time (trend and season), and the topics around " +
      "it ranked by readers. A signal of interest, not search volume.",
    variables: ["WIKIMEDIA_CONTACT"],
    help: {
      WIKIMEDIA_CONTACT:
        "Not a key: an e-mail or website where Wikimedia can reach you about this server's requests. Wikimedia asks every automated client for one, and allows 200 requests a minute with it instead of 10. It goes only in the User-Agent header of requests to Wikimedia.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-wikipedia/src/index.ts")],
  },
  {
    name: "dataforseo",
    description:
      "DataForSEO, paid per call: Google results pages block by block (AI overview and its " +
      "sources, People Also Ask, videos), keyword research, and mentions in AI answers.",
    variables: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    help: {
      DATAFORSEO_LOGIN:
        "The login of your account at https://dataforseo.com (your e-mail), shown under API Access.",
      DATAFORSEO_PASSWORD:
        "The API password under API Access at https://dataforseo.com: not your account password. Calls are paid from your DataForSEO balance.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-dataforseo/src/index.ts")],
  },
  {
    name: "nanobanana",
    description:
      "Google's Nano Banana, paid per image: generates images from a prompt, with " +
      "variations rotated in code, saved as files in the agent's workspace.",
    variables: ["GEMINI_API_KEY"],
    help: {
      GEMINI_API_KEY:
        "In https://aistudio.google.com, open Get API key and create a key in a Google Cloud project with billing on: image models have no free tier. Each image is paid from that project.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-images/src/nanobanana.ts")],
    state: "images",
  },
  {
    name: "gptimage",
    description:
      "OpenAI's GPT Image, paid per image: generates WebP images from a prompt, with " +
      "variations rotated in code, saved as files in the agent's workspace.",
    variables: ["OPENAI_API_KEY"],
    help: {
      OPENAI_API_KEY:
        "In https://platform.openai.com, go to API keys and create a secret key. GPT Image may require verifying your organization first (Settings → Organization → General). Each image is paid from that account.",
    },
    command: process.execPath,
    args: [join(PACKAGES, "mcp-images/src/gptimage.ts")],
    state: "images",
  },
];
