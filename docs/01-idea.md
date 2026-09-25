# ENSCA — The Idea

## The Problem

Crypto events like ETHGlobal are full of the most technically sophisticated attendees in the world — people with hardware wallets, multiple ENS names, and deep infrastructure knowledge. Yet the event infrastructure they use is the same anonymous, passworded, flat WiFi network you'd find at a hotel conference room.

There is no way to know who is using the network. No per-person access policy. No way to give an organizer different tools than a hacker. No device isolation. Sponsor API keys get distributed via Discord, shared, rate-limited, and burned. SSH access to shared dev machines requires manual key management. Credentials get passed around. Organizers fly blind.

The identity layer already exists — every attendee has an ENS name and a wallet. It just isn't being used.

## The Fix

ENSCA makes your ENS subname the credential for every piece of infrastructure at the event.

At check-in, you get minted a subname under the event domain:

```
philo.tokyo2026.ethglobal.eth
```

That subname carries your role, your access policy, your SSH public key, and your device group — all in ENS text records. From that point on, your identity is on-chain, your wallet is your key, and the infrastructure reads ENS instead of a password database.

## What It Replaces

| Before ENSCA | After ENSCA |
|---|---|
| Shared WiFi password | ENS subname + wallet signature |
| Same network for everyone | Role-based VLAN per identity |
| No device isolation | Per-person private LAN |
| Manual SSH key distribution | `ssh-pubkey` text record on ENS |
| Sponsor API keys on Discord | Per-identity provisioned at mint |
| No usage visibility | Per-subname analytics dashboard |
| POAP as only post-event proof | Attestations embedded in subname |

## The Insight

Every large org solves this problem with Active Directory — one identity system that controls WiFi, SSH, VPN, tool licenses, and door badges. AD is a centralised, expensive, IT-managed system that takes weeks to provision.

ENSCA is the crypto-native equivalent: decentralised identity (ENS), wallet-based authentication (ECDSA signature), on-chain policy (text records via CCIP-Read), and commodity hardware (MikroTik + Raspberry Pi).

Setup time: under an hour. Cost: under $100. Works at any event, any venue, anywhere.

## Scope

ENSCA is built for ETHGlobal events where:
- Every attendee already has a wallet
- ENS names are common
- Hardware wallets are normal
- The audience understands and trusts on-chain identity

It is not trying to solve this for general audiences. It is infrastructure by and for the crypto-native world.
