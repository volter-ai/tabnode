# Security

tabnode runs untrusted programs inside a browser tab. The tab's origin is the security boundary: a guest program can do what any script on that origin can, and no more. Isolating the guest from the embedding page (a cross-origin worker, a sandboxed frame) is the host's job; the engine does not claim to contain a program from the page that runs it.

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability report](https://github.com/volter-ai/tabnode/security/advisories/new) for this repository, or by mail to the maintainer named in `package.json`, with the engine version, what the guest program did, and what it reached that it should not have. Expect an acknowledgement within three working days. Please do not open a public issue for a vulnerability until it has shipped fixed.

## Supported versions

The latest release on npm (`@volter/tabnode`, tag `latest`) is the supported one; a fix ships as a new release, never as a patch of an old one.
