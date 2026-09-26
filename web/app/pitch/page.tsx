import type { Metadata } from "next";
import { PitchDeck } from "@/components/pitch/PitchDeck";

export const metadata: Metadata = {
  title: "Radius — pitch",
  description:
    "Five slides on Radius: identity-gated network and API access where an ENS subname is the only credential.",
};

export default function PitchPage() {
  return <PitchDeck />;
}
