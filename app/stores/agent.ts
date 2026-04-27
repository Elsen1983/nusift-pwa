// stores/agent.ts
import { defineStore } from "pinia";

export const useAgentStore = defineStore("agent", {
  state: () => ({
    agentVersion: "v4.2.0-sovereign",

    // ANCHOR ONBOARDING DATA STORAGE
    primaryRegion: null as string | null, // Új mező a régiónak
    regionalWhitelist: [] as string[],
    topSources: [] as string[],
    topInterests: [] as string[],

    // Központosított preferenciák (Súlyozott adatok)
    topPreferences: [
      {
        id: "ai_strategy",
        name: "AI & Tech Strategy",
        weight: 85,
        icon: "psychology",
      },
      {
        id: "market_analysis",
        name: "Market Analysis",
        weight: 60,
        icon: "monitoring",
      },
      { id: "geopolitics", name: "Geopolitics", weight: 45, icon: "public" },
    ],

    stats: [
      { label: "Signals Scanned", value: "1,240", icon: "radar" },
      { label: "Time Saved", value: "14h", icon: "schedule" },
      { label: "Accuracy", value: "98%", icon: "target" },
      { label: "Knowledge Nodes", value: "42", icon: "hub" },
    ],
  }),

  actions: {
    updatePreference(id: string, newWeight: number) {
      const pref = this.topPreferences.find((p) => p.id === id);
      if (pref) pref.weight = newWeight;
    },

    clearAgentState() {
      this.primaryRegion = null;
      this.regionalWhitelist = [];
      this.topSources = [];
      this.topInterests = [];
    },
  },
});
