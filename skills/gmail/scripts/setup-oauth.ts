#!/usr/bin/env tsx
/**
 * Gmail OAuth Setup
 * One-time setup to get OAuth credentials for the Gmail API.
 * Saves credentials to .credentials.json (gitignored).
 *
 * Usage: tsx setup-oauth.ts
 */

import { auth } from "@googleapis/gmail";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = resolve(__dirname, "../.credentials.json");
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.labels",
];

async function main() {
  console.log("=== Gmail OAuth Setup ===\n");

  if (existsSync(CREDENTIALS_PATH)) {
    console.log("Credentials already exist at", CREDENTIALS_PATH);
    console.log("Delete that file and re-run to re-authenticate.\n");
    return;
  }

  // Check for client credentials
  const clientCredsPath = resolve(__dirname, "../client_secret.json");
  if (!existsSync(clientCredsPath)) {
    console.log("Before running this script, you need:");
    console.log("1. Go to https://console.cloud.google.com/apis/credentials");
    console.log("2. Create an OAuth 2.0 Client ID (type: Desktop App)");
    console.log("3. Download the JSON and save it as:");
    console.log(`   ${clientCredsPath}\n`);
    process.exit(1);
  }

  const clientCreds = JSON.parse(readFileSync(clientCredsPath, "utf-8"));
  const { client_id, client_secret } =
    clientCreds.installed || clientCreds.web;

  const oauth2 = new auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nWaiting for callback...\n");

  // Start local server to catch the OAuth callback
  return new Promise<void>((resolvePromise) => {
    const server = createServer(async (req, res) => {
      if (!req.url?.startsWith("/callback")) return;

      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        res.end("No code received");
        return;
      }

      try {
        const { tokens } = await oauth2.getToken(code);

        const credentials = {
          client_id,
          client_secret,
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
        };

        writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
        console.log("Credentials saved to", CREDENTIALS_PATH);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Done!</h1><p>Gmail OAuth setup complete. You can close this tab.</p>"
        );
      } catch (err) {
        console.error("Error getting tokens:", err);
        res.writeHead(500);
        res.end("Error during authentication");
      }

      server.close();
      resolvePromise();
    });

    server.listen(PORT, () => {
      console.log(`Listening on http://localhost:${PORT}/callback`);
    });
  });
}

main().catch(console.error);
