import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');

const greetings = [
  "The deep stirs, {name}.",
  "Surfacing for you, {name}.",
  "{name}, the current answers.",
  "Back from the abyss, {name}.",
  "At your command, {name}.",
  "{name} has returned. The tide shifts.",
  "The waters remember you, {name}.",
  "Ready when you are, {name}.",
  "{name}, the depths have missed you.",
  "Systems awake. Good to see you, {name}.",
  "no cap the abyss been waiting on you {name}",
  "{name} pulled up. let's go",
  "yo {name}, we back at it",
  "sheesh, {name} in the building",
  "{name} said bet, and here we are",
  "lowkey glad you're here, {name}",
  "the grind never sleeps, {name}",
  "{name}'s in the water again",
  "vibes are immaculate, {name}",
  "let's cook, {name}",
  "Good evening, {name}. Shall we begin?",
  "At your service, {name}.",
  "As always, {name} — a pleasure.",
  "Right this way, {name}.",
  "{name}, everything stands ready for you.",
  "Your presence is noted, {name}.",
  "A fine hour to build, {name}.",
  "{name}, the terminal awaits your word.",
  "Standing by, {name}.",
  "Welcome to the depths, {name}.",
  "The leviathan opens its eyes, {name}.",
  "From darkness, a signal — hello, {name}.",
  "{name}, the sea grows still for you.",
  "Awake once more, {name}.",
  "The abyss gazes back, {name}.",
  "{name}, something ancient stirs below.",
  "Silence broken. Hello, {name}.",
  "The depths know your name, {name}.",
  "A single light in dark water — that's you, {name}.",
  "{name}, the leviathan remembers.",
  "Session initialized for {name}.",
  "Context loaded. Hello, {name}.",
  "{name} is authenticated and online.",
  "Ready to execute, {name}.",
  "Standing watch, {name}.",
  "{name}, all systems nominal.",
  "Connection established, {name}.",
  "Awaiting your next move, {name}.",
  "{name}, the console is yours.",
  "Loaded and listening, {name}.",
];

function getName() {
  try {
    const { auth } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return auth?.user?.name || auth?.user?.login || 'friend';
  } catch {
    return 'friend';
  }
}

export function getGreeting() {
  const line = greetings[Math.floor(Math.random() * greetings.length)];
  return line.replaceAll('{name}', getName());
}
