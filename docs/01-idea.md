# ENSCA — The Idea

## The Problem

Crypto events are full of technically sophisticated attendees — people with hardware wallets, multiple ENS names, deep infrastructure knowledge. Yet the event infrastructure they use is anonymous, passworded, flat WiFi — hotel conference room grade.

No per-person access policy. No device isolation. Sponsor API keys shared via Discord, burned out, untraceable. SSH access requires manual key management. Organizers fly blind.

The identity layer already exists. Every attendee has an ENS name and a wallet. It just isn't wired to the infrastructure.

## The Fix

ENSCA makes your ENS subname the credential for every piece of infrastructure at the event.

At check-in, you get minted a subname under the event domain:

```
philo.tokyo2026.ethglobal.eth
```

That subname carries your role, your access policy, your SSH public key, and your device group — all in ENS text records. From that point, your identity is on-chain, your wallet is your key, and the infrastructure reads ENS instead of a password database.

## Current State (ETHTokyo 2026 Demo)

The demo runs the network enforcement layer without ENS auth yet. Username/password maps to a tier (basic/staff/vip). The full control plane — session management, resource proxying, rate limiting, key rotation, quota management, audit logging — is implemented and running on a Fedora VM.

The captive portal and proxy service talk to each other: login creates a session, logout ends it, the proxy reads the active session to authorize every request.

## What the Demo Delivers

| Feature | Status |
|---|---|
| Software VLANs (fwmark + tc HTB) | Running |
| Captive portal with tier credentials | Running |
| Cross-tier iptables isolation | Running |
| Resource proxy with per-group access control | Running |
| Per-device + per-group daily rate limits | Running |
| API key rotation (stage + commit) | Running |
| Quota adjustments (mid-day top-ups) | Running |
| Admin token auth (bcrypt) | Running |
| Full audit log | Running |
| ENS-native wallet auth | Future (Phase 2) |
| Per-identity VLAN | Future (Phase 3) |

## What It Replaces (eventual target)

| Before ENSCA | After ENSCA |
|---|---|
| Shared WiFi password | ENS subname + wallet signature |
| Same network for everyone | Role-based VLAN per identity |
| Manual SSH key distribution | `ssh-pubkey` text record on ENS |
| Sponsor API keys on Discord | Per-identity, provisioned at mint |
| No usage visibility | Per-session analytics dashboard |
