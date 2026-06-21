// Archetypes — optional starter inspirations.
//
// Picking an archetype seeds the character spec slots; the user can override
// any slot afterwards. Free-form description is also supported (the wizard
// passes the entire description into `styleNotes` if no archetype matches).

import type { CharacterSpec } from './types.js';

export interface Archetype {
  id: string;
  label: string;
  description: string;
  spec: Omit<CharacterSpec, 'id' | 'name'>;
}

export const ARCHETYPES: Archetype[] = [
  {
    id: 'heroic-warrior',
    label: 'Heroic Warrior',
    description: 'He-Man, Conan, paladin, knight.',
    spec: {
      silhouette: 'compact chibi heroic warrior, chunky body, tiny limbs',
      palette: 'warm tan skin, blond bob hair, brown leather harness, red cape',
      props: 'small silver power sword with gold hilt',
      signatureMove: 'raises sword overhead with attached gold charge',
      faceLanguage: 'simple readable face, expressive eyes, tiny mouth',
      styleNotes: '',
      species: 'human',
    },
  },
  {
    id: 'mystic-mage',
    label: 'Mystic Mage',
    description: 'Gandalf, witch, sorcerer, wizard.',
    spec: {
      silhouette: 'compact chibi mage, robe widens slightly toward feet',
      palette: 'deep blue robe, white beard or pointed hat, gold trim',
      props: 'tall wooden staff with glowing gem at the top',
      signatureMove: 'raises staff with attached gem-light pulse',
      faceLanguage: 'simple readable face, expressive eyes, tiny mouth',
      styleNotes: '',
      species: 'human',
    },
  },
  {
    id: 'cyberpunk-hacker',
    label: 'Cyberpunk Hacker',
    description: 'Mr. Robot, Lain, generic netrunner.',
    spec: {
      silhouette: 'compact chibi hacker, hoodie, sneakers',
      palette: 'dark hoodie, neon accent stripe, mirror visor',
      props: 'tablet or holo-deck held in one hand',
      signatureMove: 'raises tablet, attached pixel-glyph cluster on screen',
      faceLanguage: 'simple readable face, expressive eyes, tiny mouth',
      styleNotes: '',
      species: 'human',
    },
  },
  {
    id: 'friendly-goblin',
    label: 'Friendly Goblin',
    description: 'Classic D&D goblin, tinker imp.',
    spec: {
      silhouette: 'tiny chibi goblin, big head, small pointy ears, broad feet',
      palette: 'olive-green skin, brown leather scraps, copper accents',
      props: 'stubby club or tinker-tool',
      signatureMove: 'swings club overhead with attached spark',
      faceLanguage: 'simple readable face, expressive eyes, tiny mouth',
      styleNotes: '',
      species: 'goblin',
    },
  },
  {
    id: 'forest-sprite',
    label: 'Forest Sprite',
    description: 'Studio Ghibli kodama, generic forest sprite.',
    spec: {
      silhouette: 'compact chibi sprite, leaf-shaped silhouette around body',
      palette: 'moss green, light brown, soft yellow accents',
      props: 'small wooden flute or mushroom cap',
      signatureMove: 'lifts flute, attached pollen swirl touching cheeks',
      faceLanguage: 'simple readable face, expressive eyes, tiny mouth',
      styleNotes: '',
      species: 'sprite',
    },
  },
  {
    id: 'robo-companion',
    label: 'Robo Companion',
    description: 'BB-8, Wall-E-style, classic 80s tin toy.',
    spec: {
      silhouette: 'compact chibi robot, boxy torso, rounded edges',
      palette: 'white plastic shell, grey panel lines, single colored eye',
      props: 'antenna or articulated tool arm',
      signatureMove: 'raises arm with attached LED-glyph pulse',
      faceLanguage: 'single colored cyclops eye, no mouth, status lights',
      styleNotes: '',
      species: 'robot',
    },
  },
];

const DEFAULT_FACE_LANGUAGE = 'simple readable face, expressive eyes, tiny mouth';

/** Build a spec from an archetype id (or null for a blank free-form spec). */
export function specFromArchetype(
  archetypeId: string | null,
  petId: string,
  petName: string,
): CharacterSpec {
  const arch = archetypeId ? ARCHETYPES.find((a) => a.id === archetypeId) : null;
  if (!arch) {
    return {
      id: petId,
      name: petName,
      silhouette: '',
      palette: '',
      props: '',
      signatureMove: '',
      faceLanguage: DEFAULT_FACE_LANGUAGE,
      styleNotes: '',
    };
  }
  return {
    id: petId,
    name: petName,
    ...arch.spec,
  };
}

/** Slugify a free-form name for use as the pet id. */
export function slugifyId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32);
}
