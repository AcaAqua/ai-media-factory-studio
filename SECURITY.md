# Security Policy

AI Media Factory Studio is designed for local-first operation.

Designed & developed by LuckyFields LLC.

## Sensitive Local Data

Do not publish:

- SQLite databases
- generated images
- prompt history
- thumbnails
- models, LoRA, checkpoints, embeddings, VAE, ControlNet, and upscale models
- API keys, tokens, `.env` files, and local config
- personal or client reference images

## Reporting

For now, report security issues privately to the project owner. Public issue reporting should be enabled only after the repository and disclosure process are finalized.

## Network Scope

Studio talks to local ComfyUI and Ollama endpoints by default. Review firewall and LAN exposure before binding ComfyUI or Studio to non-localhost addresses.

## Third-Party Materials

ComfyUI, Ollama, custom nodes, models, LoRA files, workflows, and external services are managed separately by users. Review their licenses, terms, and security implications before installing or connecting them.
