# Security policy

## Supported versions

Fixes go into the latest release. Please check that a problem still happens on the newest version before reporting it.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/rbenzing/ANSI-Studio/security/advisories/new). Do not open a public issue.

Please include what is affected, how to reproduce it, and the impact you expect. You should hear back within a week. Once a fix is released, the advisory will be published with credit unless you prefer otherwise.

## Scope

In scope: the server (`server.js`, `ai.js`), the browser app in `public/`, and the Docker image. Examples include ways to spend a deployment's model quota from another site, bypass the rate or size limits, run script in the page, or crash the server or a visitor's tab with a crafted file or share link.

Out of scope: the cost of normal use. Operators should set a spend limit with their model provider, as the README describes.
