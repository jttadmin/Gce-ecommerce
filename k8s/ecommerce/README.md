# Kart E-commerce Kubernetes deployment

This directory contains Kubernetes manifests managed through Argo CD.

Security rules:
- Never commit Kubernetes Secret manifests containing real values.
- Create the `ecommerce` namespace before deploying workloads.
- Keep application backends and databases internal to the cluster.
- Expose the frontend through the existing Traefik Gateway API setup.
- Use versioned Docker Hub images instead of `latest`.
