export interface PaperBlock {
  kind: 'title' | 'meta' | 'heading' | 'paragraph' | 'caption';
  text: string;
}

export const PAPER = {
  app: 'Acrobat Reader',
  title: 'consensus-under-adversarial-scheduling.pdf',
  figure: "/03934c25-8610-4307-b7d5-1d41bfbae5fe.jpg",
  blocks: [
  { kind: 'title', text: 'Liveness of Leader-Based Consensus under Adversarial Scheduling' },
  { kind: 'meta', text: 'R. Marchetti, S. Okonkwo, D. Vasilyev · Proc. of SOSP ’25 · pp. 118–133' },
  { kind: 'heading', text: '4.2  A failure mode that monitoring cannot see' },
  {
    kind: 'paragraph',
    text: 'In the presence of partial synchrony, the protocol degenerates into a livelock under adversarial scheduling: every replica remains responsive, yet no proposal ever attains a quorum certificate. Unlike a deadlock, no thread is blocked; the system consumes CPU at its usual rate and every health probe returns success.'
  },
  {
    kind: 'paragraph',
    text: 'This failure mode is notoriously difficult to reproduce in staging environments, because it hinges on an interleaving that a benign scheduler will almost never produce. Our fault injector therefore constructs the interleaving explicitly, granting the adversarial scheduler full knowledge of the replica state machine.'
  },
  { kind: 'caption', text: 'Figure 3: State transitions under an adversarial scheduler. The dashed cycle marks the livelock.' },
  {
    kind: 'paragraph',
    text: 'The provisional conclusion of §4 is therefore uncomfortable: liveness guarantees stated under a benign scheduler tell us very little about behaviour in the wild, and a quorum-based commit rule alone is not sufficient to rule out non-productive retry loops.'
  }] as
  PaperBlock[]
};

export interface ChatMessage {
  id: string;
  author: string;
  initials: string;
  time: string;
  text: string;
  accent: string;
}

export const CHAT = {
  app: 'Slack',
  title: '#proj-atlas',
  messages: [
  {
    id: 'm1',
    author: 'Dana Whitfield',
    initials: 'DW',
    time: '10:12',
    text: "Quick one before standup — can you give me a ballpark figure for the migration effort? Nothing binding, I just need something for the steering deck.",
    accent: '#8a5a3b'
  },
  {
    id: 'm2',
    author: 'Marcus Hale',
    initials: 'MH',
    time: '10:14',
    text: "Honestly I don't have the bandwidth to scope it properly before the release freeze. Let's park the pricing question and circle back on it after the legal review.",
    accent: '#3b6a8a'
  },
  {
    id: 'm3',
    author: 'Dana Whitfield',
    initials: 'DW',
    time: '10:15',
    text: 'Fair. Looping in Priya, who owns the billing service — she can sanity-check the numbers when we get there.',
    accent: '#8a5a3b'
  }] as
  ChatMessage[]
};

export const DEMO_TERMS = [
'degenerates',
'livelock',
'deadlock',
'adversarial',
'quorum',
'interleaving',
'provisional',
'ballpark',
'bandwidth',
'circle back',
'Looping in'];


export const WALLPAPER_LIGHT = "/2c289357-34ac-4f7f-a87b-992be2963c85.jpg";

export const WALLPAPER_DARK = "/366e946f-60e6-4e70-8983-2dacb86742b0.jpg";