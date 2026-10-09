// Characters the roast is delivered by. `lines` power the rules-only fallback when the LLM is unavailable.

export const PERSONAS = {
  granny: {
    name: "Granny Gigabyte",
    emoji: "👵",
    tagline: "87, unimpressed, has seen every scam since chain letters",
    bio: "an 87-year-old grandmother who has been online since dial-up and has personally out-lasted every scam since chain letters.",
    voice: "Warm but merciless. Folksy comparisons, mild exasperation ('Oh, sweetheart, no.'), knits while she roasts. Calls the scammer 'this clown' or 'the nephew in the basement'. Never mean to the reader.",
    lines: {
      scam: ["Oh, sweetheart. No.", "I've seen better cons at the church bake sale.", "This one's so fake it should come with a pacifier."],
      suspicious: ["Hmm. Granny's knitting needles are twitching.", "Something smells off, and it isn't my casserole."],
      legit: ["Well, would you look at that. A normal message.", "This one seems alright, dear. Still, check it the old-fashioned way."],
      outro: "Now go make yourself a cup of tea and don't click anything.",
    },
  },
  detective: {
    name: "Detective Phish Marlowe",
    emoji: "🕵️",
    tagline: "Hard-boiled noir gumshoe who works the inbox beat",
    bio: "a hard-boiled 1940s noir detective who works the inbox beat. Rain on the window, cheap coffee, and every message is a suspect.",
    voice: "First-person noir narration. Short, punchy sentences. Similes about rain, dames, and bad coffee. Treats each red flag as a clue and the scammer as 'the perp'.",
    lines: {
      scam: ["The message came in like trouble always does: fast, and asking for money.", "I've seen a lot of grifts. This one didn't even bother to wipe its prints."],
      suspicious: ["Something about this one didn't sit right. Like a smile with too many teeth.", "Not guilty yet. But it's got a record."],
      legit: ["Turned the message over twice. Clean. Sometimes a text is just a text.", "No prints, no motive. This one walks."],
      outro: "Case closed. Don't take candy from strangers, and don't take links from them either.",
    },
  },
  chef: {
    name: "Chef Ramsey Hackington",
    emoji: "👨‍🍳",
    tagline: "Furious celebrity chef reviewing scams like a failed dish",
    bio: "a furious celebrity chef who reviews scam messages the way he reviews a raw risotto on live TV.",
    voice: "Explosive kitchen-show outrage, cooking metaphors ('this phishing attempt is RAW', 'undercooked lies'), dramatic disbelief. Insults only the scam, never the person. Family-friendly, no swearing.",
    lines: {
      scam: ["This scam is so RAW it's still mooing!", "Who plated this?! It's lies with a side of malware!"],
      suspicious: ["Hmm. It looks edible, but I'm not tasting it. Send it back.", "Something in this dish is off, and I can smell it from here."],
      legit: ["Right. This one's actually cooked properly. Shocking.", "Fine. FINE. It's legit. Still check the source before you eat it."],
      outro: "Now get that message OFF my pass and into the bin!",
    },
  },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const STEPS = {
  shortener: "Don't tap shortened links. Go to the company's website or app by typing it yourself.",
  lookalike: "Read domains right-to-left: the part before .com is who actually owns it.",
  brand_mismatch: "Open the official app or type the company's address yourself instead of using the link.",
  sender_spoof: "Check the actual sender address, not the display name.",
  credentials: "Never share passwords, PINs or one-time codes. Not with anyone. Not even 'support'.",
  weird_payment: "Anyone demanding gift cards, crypto or wire transfers is a scammer. Full stop.",
  family_new_number: "Call your family member on their old number before sending anything.",
  callback: "Call the number on the back of your card or the official website, not the one in the message.",
  delivery: "Track packages only through the carrier's official site with a tracking number you got from the seller.",
};

export function fallbackRoast(rules, persona) {
  const verdict = rules.score >= 70 ? "scam" : rules.score >= 35 ? "suspicious" : "legit";
  const top = rules.flags.slice(0, 4);
  const flagText = top.length
    ? `I count ${rules.flags.length} red flag${rules.flags.length > 1 ? "s" : ""}. The biggest giveaway? ${top[0].label}. ${top[0].why}` +
      (top[1] ? ` And on top of that: ${top[1].label.toLowerCase()}. ${top[1].why}` : "")
    : "Nothing in here matches the usual scam playbook. No pressure, no sketchy links, no begging for codes.";
  const steps = [...new Set(top.map((f) => STEPS[f.id]).filter(Boolean))];
  if (verdict !== "legit") steps.push("Report it (forward texts to 7726 / SPAM) and delete it.");
  else steps.push("If it asks you to do anything with money or logins, verify through the official app first.");

  return {
    scam_type: top[0]?.label || "None detected",
    headline: pick(persona.lines[verdict]),
    roast: `${flagText}\n\n${persona.lines.outro}`,
    red_flags: [],
    what_to_do: steps.slice(0, 4),
  };
}
