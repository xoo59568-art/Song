import axios from "axios";
import os from "os";
import fs from "fs";
export async function getJson(url, options = {}) {
  try {
    const res = await axios({
      method: "GET",
      url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36",
      },
      ...options,
    });
    return res.data;
  } catch (err) {
    // preserve previous behavior (returned error). If you prefer, change to: throw err;
    return err;
  }
}
export function MediaUrls(text) {
  if (typeof text !== "string") return false;
  const array = [];
  const regexp =
    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()'@:%_\+.~#?!&\/=]*)/gi;
  const urls = text.match(regexp);
  if (urls) {
    urls.forEach((url) => {
      const ext = url.split(".").pop().split(/[?#]/)[0].toLowerCase();
      if (["jpg", "jpeg", "png", "gif", "mp4", "webp"].includes(ext)) {
        array.push(url);
      }
    });
    return array;
  }
  return false;
}

export default async function eventlogger() {
	['error', 'warn', 'info', 'debug', 'trace'].forEach(method => {
		console[method] = () => {};
	});

	// FIX: use dynamic import instead of require() — project is ESM
	try {
		const pino = await import('pino');
		const logger = pino.default || pino;
		if (logger && logger.createLogger) {
			logger.createLogger = () => ({
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			});
		}
	} catch {}
}


export function detectPlatformName({
  env = process.env,
  osModule = os,
  fsModule = fs,
  emoji = false,
} = {}) {
  const hasAny = (...keys) => keys.some((k) => !!env[k]);

  const checks = [
    {
      name: "Vercel",
      test: () => hasAny("VERCEL", "VERCEL_ENV", "NOW_REGION"),
    },
    {
      name: "Railway",
      test: () => hasAny("RAILWAY_STATIC_URL", "RAILWAY_ENVIRONMENT"),
    },
    {
      name: "Render",
      test: () => hasAny("RENDER", "RENDER_INSTANCE_ID", "RENDER_EXTERNAL_URL"),
    },
    {
      name: "Netlify",
      test: () => hasAny("NETLIFY", "NETLIFY_BUILD_ID", "NETLIFY_AUTH_TOKEN"),
    },
    {
      name: "Heroku",
      test: () => hasAny("HEROKU_APP_NAME", "HEROKU_API_KEY", "DYNO"),
    },
    { name: "Replit", test: () => hasAny("REPL_ID", "REPL_SLUG") },
    {
      name: "Glitch",
      test: () =>
        hasAny("PROJECT_REMIX_CHAIN", "GIT_REPO_SLUG", "GLITCH_PROJECT"),
    },
    { name: "Fly.io", test: () => hasAny("FLY_REGION", "FLY_APP_NAME") },
    {
      name: "Cloudflare",
      test: () => hasAny("CF_PAGES", "CF_ACCOUNT_ID", "CLOUDFLARE_WORKERS"),
    },
    {
      name: "AWS",
      test: () =>
        hasAny(
          "AWS_EXECUTION_ENV",
          "AWS_LAMBDA_FUNCTION_NAME",
          "ECS_CONTAINER_METADATA_URI",
          "EC2_INSTANCE_ID"
        ),
    },
    {
      name: "Google Cloud",
      test: () =>
        hasAny(
          "GCP_PROJECT",
          "GAE_SERVICE",
          "GCP_INSTANCE_ID",
          "FUNCTION_NAME",
          "K_SERVICE"
        ),
    },
    {
      name: "Azure",
      test: () =>
        hasAny(
          "WEBSITE_SITE_NAME",
          "FUNCTIONS_WORKER_RUNTIME",
          "WEBSITE_INSTANCE_ID",
          "AZURE_HTTP_USER_AGENT"
        ),
    },
    {
      name: "Kubernetes",
      test: () => !!(env.KUBERNETES_SERVICE_HOST || env.KUBE_SERVICE_PORT),
    },
    { name: "Termux (Android)", test: () => hasAny("TERMUX_VERSION") },
    {
      name: "CI (GitHub/GitLab/Circle)",
      test: () => hasAny("GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI"),
    },
  ];

  for (const c of checks) {
    try {
      if (c.test()) return emoji ? addEmoji(c.name) : c.name;
    } catch (e) {
      // ignore and continue
    }
  }

  try {
    if (fsModule) {
      if (fsModule.existsSync("/.dockerenv"))
        return emoji ? addEmoji("Docker") : "Docker";
      if (fsModule.existsSync("/run/.containerenv"))
        return emoji ? addEmoji("Container") : "Container";
      if (fsModule.existsSync("/proc/1/cgroup")) {
        const cg = fsModule.readFileSync("/proc/1/cgroup", "utf8");
        if (
          cg &&
          (cg.includes("docker") ||
            cg.includes("kubepods") ||
            cg.includes("containerd") ||
            cg.includes("lxc"))
        ) {
          return emoji
            ? addEmoji(cg.includes("kubepods") ? "Kubernetes" : "Docker")
            : cg.includes("kubepods")
            ? "Kubernetes"
            : "Docker";
        }
      }
    }
  } catch (e) {
    // ignore fs errors
  }

  // WSL detection
  try {
    const release =
      osModule.release && typeof osModule.release === "function"
        ? osModule.release().toLowerCase()
        : "";
    if (hasAny("WSL_DISTRO_NAME") || release.includes("microsoft"))
      return emoji ? addEmoji("WSL") : "WSL";
  } catch (e) {
    /* ignore */
  }

  // Fallback to OS type
  try {
    const t =
      osModule.type && typeof osModule.type === "function"
        ? osModule.type()
        : "";
    const map = { Linux: "Linux", Darwin: "macOS", Windows_NT: "Windows" };
    if (t in map) return emoji ? addEmoji(map[t]) : map[t];
    if (t) return emoji ? addEmoji(t) : t;
  } catch (e) {
    /* ignore */
  }

  return emoji ? addEmoji("Unknown") : "Unknown";
}

function addEmoji(name) {
  const map = {
    Railway: "🚄 Railway",
    Vercel: "⚡ Vercel",
    Render: "🎛️ Render",
    Netlify: "🌊 Netlify",
    Heroku: "☘️ Heroku",
    Replit: "🔁 Replit",
    Glitch: "🧩 Glitch",
    "Fly.io": "✈️ Fly.io",
    Cloudflare: "☁️ Cloudflare",
    AWS: "☁️ AWS",
    "Google Cloud": "☁️ Google Cloud",
    Azure: "🔷 Azure",
    Kubernetes: "☸️ Kubernetes",
    Docker: "🐳 Docker",
    Container: "📦 Container",
    WSL: "🪟 WSL",
    "Termux (Android)": "📱 Termux (Android)",
    Linux: "🐧 Linux",
    macOS: "🍎 macOS",
    Windows: "🪟 Windows",
    Unknown: "❓ Unknown",
  };
  return map[name] || name;
}
