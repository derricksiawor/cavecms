// English rule pack for the readability + SEO scorers. Everything here is data
// + one pure heuristic (`countSyllables`). No I/O, no globals — safe in the
// browser and on the server.
//
// The lists below are intentionally generous. Yoast-style scoring measures the
// PERCENTAGE of sentences that contain a transition word / passive construction,
// so coverage matters more than precision: a missing common transition word
// understates the transition-word percentage and unfairly dings good prose.

import type { LocaleRulePack } from '../types'
import { buildTransitionIndex } from '../text'

// ---------------------------------------------------------------------------
// Transition words & phrases (lowercased). Multi-word phrases are matched as a
// consecutive token run by the readability check, so "as a result" only fires
// on the actual phrase. Single words ("however", "therefore") fire on the word.
//
// This is ≥150 entries spanning the common categories: addition, contrast,
// cause/effect, sequence, example, emphasis, conclusion, condition, comparison.
// ---------------------------------------------------------------------------
export const EN_TRANSITION_WORDS: string[] = [
  // Addition
  'additionally',
  'also',
  'and',
  'furthermore',
  'moreover',
  'besides',
  'too',
  'as well as',
  'in addition',
  'not only',
  'but also',
  'coupled with',
  'likewise',
  'similarly',
  'equally',
  'correspondingly',
  'what is more',
  "what's more",
  'on top of that',
  'in the same way',
  'by the same token',
  'together with',
  'along with',
  // Contrast
  'but',
  'however',
  'nevertheless',
  'nonetheless',
  'yet',
  'still',
  'although',
  'though',
  'even though',
  'whereas',
  'while',
  'conversely',
  'on the other hand',
  'on the contrary',
  'in contrast',
  'by contrast',
  'in comparison',
  'instead',
  'rather',
  'alternatively',
  'otherwise',
  'despite',
  'in spite of',
  'regardless',
  'notwithstanding',
  'even so',
  'all the same',
  'at the same time',
  'then again',
  'be that as it may',
  'different from',
  'unlike',
  // Cause & effect
  'because',
  'since',
  'as',
  'therefore',
  'thus',
  'hence',
  'consequently',
  'accordingly',
  'as a result',
  'as a consequence',
  'for this reason',
  'for that reason',
  'so that',
  'due to',
  'owing to',
  'thanks to',
  'because of',
  'in order to',
  'in order that',
  'so as to',
  'with the result that',
  'this means that',
  'which means',
  // Sequence / time
  'first',
  'firstly',
  'second',
  'secondly',
  'third',
  'thirdly',
  'next',
  'then',
  'afterward',
  'afterwards',
  'subsequently',
  'finally',
  'lastly',
  'eventually',
  'meanwhile',
  'in the meantime',
  'simultaneously',
  'before',
  'after',
  'earlier',
  'later',
  'previously',
  'formerly',
  'to begin with',
  'to start with',
  'at first',
  'in the first place',
  'at last',
  'in the end',
  'once',
  'until now',
  'up to now',
  'as soon as',
  'at this point',
  'following this',
  'to conclude',
  // Example / illustration
  'for example',
  'for instance',
  'such as',
  'namely',
  'specifically',
  'in particular',
  'particularly',
  'to illustrate',
  'as an illustration',
  'including',
  'like',
  'that is',
  'in other words',
  'to put it another way',
  'to put it differently',
  'as an example',
  'in this case',
  'as shown',
  'consider',
  // Emphasis
  'indeed',
  'in fact',
  'as a matter of fact',
  'certainly',
  'clearly',
  'obviously',
  'undoubtedly',
  'absolutely',
  'definitely',
  'naturally',
  'of course',
  'above all',
  'most importantly',
  'importantly',
  'significantly',
  'notably',
  'especially',
  'chiefly',
  'mainly',
  'primarily',
  'truly',
  'in truth',
  'to emphasize',
  'without a doubt',
  // Conclusion / summary
  'in conclusion',
  'to conclude',
  'in summary',
  'to summarize',
  'to sum up',
  'in short',
  'in brief',
  'briefly',
  'overall',
  'all in all',
  'on the whole',
  'altogether',
  'ultimately',
  'in the final analysis',
  'given these points',
  'as has been noted',
  'as can be seen',
  'in any event',
  'in either case',
  'all things considered',
  // Condition
  'if',
  'unless',
  'provided that',
  'providing that',
  'in case',
  'as long as',
  'even if',
  'only if',
  'whether',
  'in the event that',
  'on condition that',
  'assuming that',
  // Comparison / concession
  'compared to',
  'compared with',
  'in the same manner',
  'just as',
  'just like',
  'in like manner',
  'admittedly',
  'granted',
  'of course',
  'naturally',
  'to be sure',
  'after all',
  // Spatial / reference
  'here',
  'there',
  'beyond',
  'nearby',
  'opposite to',
  'adjacent to',
  'in front of',
  'meanwhile',
]

// ---------------------------------------------------------------------------
// Passive auxiliaries — the "be"-family verbs (plus get-passive forms). The
// passive-voice heuristic looks for one of these followed within a few words by
// a past-participle-ish token (an -ed word or an irregular participle).
// ---------------------------------------------------------------------------
export const EN_PASSIVE_AUXILIARIES: string[] = [
  'be',
  'is',
  'are',
  'was',
  'were',
  'been',
  'being',
  'am',
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  // get-passive (optional, common in informal prose): "got hired", "get paid"
  'get',
  'gets',
  'got',
  'gotten',
  'getting',
]

// ---------------------------------------------------------------------------
// Function / stop words (≥120). Used to (a) strip keyphrase "content words" and
// (b) detect a keyphrase that is ONLY function words. Includes articles,
// pronouns, prepositions, conjunctions, auxiliaries, and common determiners.
// ---------------------------------------------------------------------------
export const EN_FUNCTION_WORDS: string[] = [
  // Articles
  'a',
  'an',
  'the',
  // Conjunctions
  'and',
  'or',
  'but',
  'nor',
  'so',
  'yet',
  'for',
  'because',
  'although',
  'though',
  'while',
  'whereas',
  'if',
  'unless',
  'until',
  'than',
  'whether',
  'as',
  // Prepositions
  'about',
  'above',
  'across',
  'after',
  'against',
  'along',
  'among',
  'around',
  'at',
  'before',
  'behind',
  'below',
  'beneath',
  'beside',
  'between',
  'beyond',
  'by',
  'down',
  'during',
  'except',
  'from',
  'in',
  'inside',
  'into',
  'near',
  'of',
  'off',
  'on',
  'onto',
  'out',
  'outside',
  'over',
  'past',
  'since',
  'through',
  'throughout',
  'to',
  'toward',
  'towards',
  'under',
  'underneath',
  'up',
  'upon',
  'with',
  'within',
  'without',
  // Pronouns
  'i',
  'me',
  'my',
  'mine',
  'myself',
  'we',
  'us',
  'our',
  'ours',
  'ourselves',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'he',
  'him',
  'his',
  'himself',
  'she',
  'her',
  'hers',
  'herself',
  'it',
  'its',
  'itself',
  'they',
  'them',
  'their',
  'theirs',
  'themselves',
  'this',
  'that',
  'these',
  'those',
  'who',
  'whom',
  'whose',
  'which',
  'what',
  'whatever',
  'whoever',
  'whomever',
  // Auxiliary / modal verbs
  'am',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'will',
  'would',
  'shall',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'ought',
  // Determiners / quantifiers
  'all',
  'any',
  'both',
  'each',
  'either',
  'every',
  'few',
  'many',
  'more',
  'most',
  'much',
  'neither',
  'no',
  'none',
  'some',
  'such',
  'several',
  'enough',
  // Common adverbial fillers
  'not',
  'only',
  'own',
  'same',
  'too',
  'very',
  'just',
  'also',
  'then',
  'there',
  'here',
  'when',
  'where',
  'why',
  'how',
]

// ---------------------------------------------------------------------------
// Syllable counter — an English vowel-group heuristic. It is NOT a dictionary,
// but it is the standard approximation used by Flesch implementations:
//
//   1. Lowercase, keep only a–z.
//   2. Count groups of consecutive vowels (a,e,i,o,u,y) — each group ≈ one
//      syllable nucleus.
//   3. Subtract one for a silent trailing "e" (but not "le" after a consonant,
//      as in "table" / "little", which IS pronounced).
//   4. Never return less than 1 for a word with letters.
//
// This is good enough for Flesch Reading Ease, which is itself an approximation.
// ---------------------------------------------------------------------------
export function countSyllables(word: string): number {
  // Strip everything except a–z and lowercase. Numbers / punctuation contribute
  // no syllables for this heuristic.
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length === 0) return 0
  if (w.length <= 2) return 1 // "I", "a", "an", "to" — one beat.

  // Count vowel groups. `y` counts as a vowel here (it carries a syllable in
  // "rhythm", "my", "happy").
  const groups = w.match(/[aeiouy]+/g)
  let count = groups ? groups.length : 0

  // Silent trailing-e adjustment. A word ending in a lone "e" usually has that
  // "e" silent ("make", "code"), so subtract one — UNLESS the word ends in "le"
  // ("table", "little", "candle"), where the "-le" carries its own beat. In the
  // "-le" case we deliberately DON'T subtract (the trailing "e" was already
  // counted as its own vowel group by the regex above, which correctly gives
  // "ta-ble" two beats). No other adjustment is needed for "-le".
  if (w.endsWith('e') && !w.endsWith('le')) {
    count -= 1
  }

  // Floor at 1: every real word is at least one syllable.
  return Math.max(1, count)
}

// PRECOMPUTED at module load (Fix 10): the transition lookup index + the
// passive-auxiliary Set. checkTransitionWords previously re-tokenized all ~200
// transition phrases on EVERY call (≈600k comparisons/keystroke); the
// passive-voice check rebuilt its auxiliary Set per call. Building these once
// here makes both checks O(sentence tokens) instead of O(sentences × phrases).
const EN_TRANSITION_INDEX = buildTransitionIndex(EN_TRANSITION_WORDS)
const EN_PASSIVE_AUXILIARY_SET: ReadonlySet<string> = new Set(
  EN_PASSIVE_AUXILIARIES,
)

export const en: LocaleRulePack = {
  locale: 'en',
  transitionWords: EN_TRANSITION_WORDS,
  transitionSingle: EN_TRANSITION_INDEX.single,
  transitionMulti: EN_TRANSITION_INDEX.multi,
  passiveAuxiliaries: EN_PASSIVE_AUXILIARIES,
  passiveAuxiliarySet: EN_PASSIVE_AUXILIARY_SET,
  functionWords: EN_FUNCTION_WORDS,
  countSyllables,
}
