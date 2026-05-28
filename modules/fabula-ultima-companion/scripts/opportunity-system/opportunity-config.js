/**
 * [ONI] Opportunity System — Config
 * Single source of truth for all opportunity option definitions.
 * Exposed as window["oni.OpportunityConfig"].
 */
(() => {
  const TAG = "[ONI][OpportunitySystem:Config]";

  const OPTIONS = [
    {
      id: "advantage",
      label: "Advantage",
      description: "The next Check performed by you or an ally receives a +4 bonus.",
      icon: "fa-angles-up",
      color: "#4c8a4c",
      gmApproveNeeded: false,
    },
    {
      id: "affliction",
      label: "Affliction",
      description: "A creature suffers dazed, shaken, slow, or weak (your choice).",
      icon: "fa-skull",
      color: "#8a4c4c",
      gmApproveNeeded: false,
    },
    {
      id: "bonding",
      label: "Bonding",
      description: "You create a Bond towards someone or add an emotion to one of your existing Bonds.",
      icon: "fa-heart",
      color: "#c26cac",
      gmApproveNeeded: false,
    },
    {
      id: "faux_pas",
      label: "Faux Pas",
      description: "Choose a creature present on the scene: they make a compromising statement chosen by the person who controls them.",
      icon: "fa-comment-slash",
      color: "#8a6c2a",
      gmApproveNeeded: false,
    },
    {
      id: "favor",
      label: "Favor",
      description: "Your actions earn you someone's support or admiration.",
      icon: "fa-handshake",
      color: "#4c6c8a",
      gmApproveNeeded: false,
    },
    {
      id: "information",
      label: "Information",
      description: "You spot a useful clue or detail. The Game Master may tell you what it is, or ask you to introduce that detail yourself.",
      icon: "fa-magnifying-glass",
      color: "#4c7a8a",
      gmApproveNeeded: false,
    },
    {
      id: "lost_item",
      label: "Lost Item",
      description: "An item is destroyed, lost, stolen, or left behind.",
      icon: "fa-box-open",
      color: "#6a4a2a",
      gmApproveNeeded: false,
    },
    {
      id: "plot_twist",
      label: "Plot Twist!",
      description: "Someone or something of your choice suddenly appears on the scene.",
      icon: "fa-wand-magic-sparkles",
      color: "#5a3a8a",
      gmApproveNeeded: false,
    },
    {
      id: "progress",
      label: "Progress",
      description: "You may fill or erase up to two sections on a Clock.",
      icon: "fa-clock",
      color: "#2a6a8a",
      gmApproveNeeded: false,
    },
    {
      id: "scan",
      label: "Scan",
      description: "You discover one Vulnerability or one Trait of a creature you can see.",
      icon: "fa-eye",
      color: "#2a7a5a",
      gmApproveNeeded: false,
    },
    {
      id: "unmask",
      label: "Unmask",
      description: "You learn the goals and motivations of a creature of your choice.",
      icon: "fa-mask",
      color: "#6a2a6a",
      gmApproveNeeded: false,
    },
    {
      id: "custom",
      label: "Custom",
      description: "Propose a different twist that fits the current scene. The Game Master has final say.",
      icon: "fa-pen-to-square",
      color: "#5a5a5a",
      gmApproveNeeded: true,
    },
  ];

  window["oni.OpportunityConfig"] = Object.freeze({ OPTIONS: Object.freeze(OPTIONS) });

  console.debug(`${TAG} Loaded ${OPTIONS.length} options.`);
})();
