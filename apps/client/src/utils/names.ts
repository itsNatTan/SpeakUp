import { generateHash } from './strings';

enum Colors {
  RED = 'red',
  ORANGE = 'orange',
  AMBER = 'amber',
  YELLOW = 'yellow',
  LIME = 'lime',
  GREEN = 'green',
  EMERALD = 'emerald',
  TEAL = 'teal',
  CYAN = 'cyan',
  SKY = 'sky',
  BLUE = 'blue',
  INDIGO = 'indigo',
  VIOLET = 'violet',
  PURPLE = 'purple',
  FUCHSIA = 'fuchsia',
  PINK = 'pink',
  ROSE = 'rose',
}

const colors: ReadonlyArray<Colors> = Object.values(Colors);

const colorToClassMap: Readonly<Record<Colors, [string, string, string]>> =
  Object.freeze({
    [Colors.RED]: ['bg-red-200', 'text-red-600', 'border-red-700'],
    [Colors.ORANGE]: ['bg-orange-200', 'text-orange-600', 'border-orange-700'],
    [Colors.AMBER]: ['bg-amber-200', 'text-amber-600', 'border-amber-700'],
    [Colors.YELLOW]: ['bg-yellow-200', 'text-yellow-600', 'border-yellow-700'],
    [Colors.LIME]: ['bg-lime-200', 'text-lime-600', 'border-lime-700'],
    [Colors.GREEN]: ['bg-green-200', 'text-green-600', 'border-green-700'],
    [Colors.EMERALD]: [
      'bg-emerald-200',
      'text-emerald-600',
      'border-emerald-700',
    ],
    [Colors.TEAL]: ['bg-teal-200', 'text-teal-600', 'border-teal-700'],
    [Colors.CYAN]: ['bg-cyan-200', 'text-cyan-600', 'border-cyan-700'],
    [Colors.SKY]: ['bg-sky-200', 'text-sky-600', 'border-sky-700'],
    [Colors.BLUE]: ['bg-blue-200', 'text-blue-600', 'border-blue-700'],
    [Colors.INDIGO]: ['bg-indigo-200', 'text-indigo-600', 'border-indigo-700'],
    [Colors.VIOLET]: ['bg-violet-200', 'text-violet-600', 'border-violet-700'],
    [Colors.PURPLE]: ['bg-purple-200', 'text-purple-600', 'border-purple-700'],
    [Colors.FUCHSIA]: [
      'bg-fuchsia-200',
      'text-fuchsia-600',
      'border-fuchsia-700',
    ],
    [Colors.PINK]: ['bg-pink-200', 'text-pink-600', 'border-pink-700'],
    [Colors.ROSE]: ['bg-rose-200', 'text-rose-600', 'border-rose-700'],
  });

export const getColorClasses = (color: Colors) => {
  const [background, foreground, border] = colorToClassMap[color];
  return { background, foreground, border };
};

enum Adjectives {
  ADORABLE = 'Adorable',
  BEAUTIFUL = 'Beautiful',
  CHARMING = 'Charming',
  CLEAN = 'Clean',
  DAZZLING = 'Dazzling',
  DELIGHTFUL = 'Delightful',
  DRAB = 'Drab',
  ELEGANT = 'Elegant',
  FANCY = 'Fancy',
  GLAMOROUS = 'Glamorous',
  HANDSOME = 'Handsome',
  LOVELY = 'Lovely',
  MAGNIFICENT = 'Magnificent',
  MYSTERIOUS = 'Mysterious',
  NATURAL = 'Natural',
  OUTSTANDING = 'Outstanding',
  SHINY = 'Shiny',
  SPARKLING = 'Sparkling',
  VIBRANT = 'Vibrant',
  WONDERFUL = 'Wonderful',
  XENIAL = 'Xenial',
  YOUTHFUL = 'Youthful',
}

const adjectives: ReadonlyArray<Adjectives> = Object.values(Adjectives);

enum Animals {
  ANT = 'Ant',
  ANTEATER = 'Anteater',
  BEAR = 'Bear',
  BUTTERFLY = 'Butterfly',
  CAT = 'Cat',
  CHAMELEON = 'Chameleon',
  CHICKEN = 'Chicken',
  DIMETRODON = 'Dimetrodon',
  DOG = 'Dog',
  DONKEY = 'Donkey',
  ELEPHANT = 'Elephant',
  FISH = 'Fish',
  FROG = 'Frog',
  HORSE = 'Horse',
  KANGAROO = 'Kangaroo',
  LION = 'Lion',
  MONKEY = 'Monkey',
  OWL = 'Owl',
  PENGUIN = 'Penguin',
  RABBIT = 'Rabbit',
  RHINO = 'Rhino',
  SEAHORSE = 'Seahorse',
  SNAKE = 'Snake',
  SQUID = 'Squid',
  TIGER = 'Tiger',
  UNICORN = 'Unicorn',
  VULTURE = 'Vulture',
  WHALE = 'Whale',
}

const animals: ReadonlyArray<Animals> = Object.values(Animals);

const animalToIconMap: Readonly<Record<Animals, string>> = Object.freeze({
  [Animals.ANT]: 'game-icons:ant',
  [Animals.ANTEATER]: 'game-icons:anteater',
  [Animals.BEAR]: 'game-icons:bear-head',
  [Animals.BUTTERFLY]: 'game-icons:butterfly',
  [Animals.CAT]: 'game-icons:cat',
  [Animals.CHAMELEON]: 'game-icons:chameleon-glyph',
  [Animals.CHICKEN]: 'game-icons:chicken',
  [Animals.DIMETRODON]: 'game-icons:dimetrodon',
  [Animals.DOG]: 'game-icons:sitting-dog',
  [Animals.DONKEY]: 'game-icons:donkey',
  [Animals.ELEPHANT]: 'game-icons:elephant',
  [Animals.FISH]: 'game-icons:tropical-fish',
  [Animals.FROG]: 'game-icons:frog',
  [Animals.HORSE]: 'game-icons:horse-head',
  [Animals.KANGAROO]: 'game-icons:kangaroo',
  [Animals.LION]: 'game-icons:lion',
  [Animals.MONKEY]: 'game-icons:monkey',
  [Animals.OWL]: 'game-icons:barn-owl',
  [Animals.PENGUIN]: 'game-icons:penguin',
  [Animals.RABBIT]: 'game-icons:rabbit-head',
  [Animals.RHINO]: 'game-icons:rhinoceros-horn',
  [Animals.SEAHORSE]: 'game-icons:seahorse',
  [Animals.SNAKE]: 'game-icons:snake-spiral',
  [Animals.SQUID]: 'game-icons:giant-squid',
  [Animals.TIGER]: 'game-icons:tiger-head',
  [Animals.UNICORN]: 'game-icons:unicorn',
  [Animals.VULTURE]: 'game-icons:vulture',
  [Animals.WHALE]: 'game-icons:sperm-whale',
});

export const generateName = (): string => {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adjective} ${animal}`;
};

export const getColor = (name: string): Colors => {
  const hash = Math.abs(generateHash(name));
  return colors[hash % colors.length];
};

export const getIcon = (name: string): string => {
  const animal = name.split(' ')[1] as Animals;
  return animalToIconMap[animal];
};
