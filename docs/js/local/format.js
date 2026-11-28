// Tournament shape chosen at creation time. Group games are generated up
// front; knockout rounds are created by the organizer once the qualifiers are
// known, so every game always has two real teams.
const GROUP_STAGES = new Set(['single', 'double', 'none']);
const KNOCKOUT_STAGES = ['none', 'final', 'semifinal', 'quarterfinal'];
const STAGE_LABELS = {
  group: 'Group stage',
  qf: 'Quarterfinal',
  sf: 'Semifinal',
  third: 'Third place',
  final: 'Final',
  placement: '5th/6th place'
};
// Knockout rounds that carry a bracket, in order.
const KNOCKOUT_SEQUENCE = ['qf', 'sf', 'final'];
const MAX_FIXTURE_GAMES = 2000;

function intIn(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function normalizeFormat(input, teamCount) {
  if (input === undefined || input === null) return { format: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'format must be an object' };

  const groupStage = GROUP_STAGES.has(input.groupStage) ? input.groupStage : 'single';
  const knockout = KNOCKOUT_STAGES.includes(input.knockout) ? input.knockout : 'none';
  let groups = intIn(input.groups, 1, 16, 1);
  const advancePerGroup = intIn(input.advancePerGroup, 1, 4, 2);
  // A third-place playoff only makes sense when there are semifinals, and a
  // 5th/6th place match needs at least two teams beyond the knockout bracket.
  const thirdPlace = Boolean(input.thirdPlace) && (knockout === 'semifinal' || knockout === 'quarterfinal');
  const bracket = knockout === 'quarterfinal' ? 8 : knockout === 'semifinal' ? 4 : knockout === 'final' ? 2 : 0;
  const placement = Boolean(input.placement) && groupStage !== 'none' && knockout !== 'none'
    && (!teamCount || teamCount >= bracket + 2);

  if (groupStage === 'none') groups = 1;
  if (groupStage !== 'none' && teamCount && groups * 2 > teamCount) {
    return { error: 'Each group needs at least two teams' };
  }
  if (groupStage === 'none' && knockout === 'none') {
    return { error: 'Choose a group stage or at least one knockout round' };
  }
  if (groupStage === 'none' && groups > 1) {
    return { error: 'A knockout-only tournament has no groups' };
  }

  return {
    format: { groups, groupStage, knockout, advancePerGroup, thirdPlace, placement }
  };
}

// The rounds an organizer can pick when creating a game by hand.
function stagesFor(format) {
  if (!format) return ['group', 'qf', 'sf', 'third', 'final', 'placement'];
  const stages = [];
  if (format.groupStage !== 'none') stages.push('group');
  if (format.knockout === 'quarterfinal') stages.push('qf', 'sf', 'final');
  else if (format.knockout === 'semifinal') stages.push('sf', 'final');
  else if (format.knockout === 'final') stages.push('final');
  if (format.thirdPlace && stages.includes('final')) stages.splice(stages.indexOf('final'), 0, 'third');
  if (format.placement && format.groupStage !== 'none') stages.push('placement');
  return stages;
}

function stageLabel(stage) {
  return STAGE_LABELS[stage] || '';
}

function formatSummary(format) {
  if (!format) return '';
  const parts = [];
  if (format.groupStage !== 'none') {
    parts.push(`${format.groups} group${format.groups === 1 ? '' : 's'}`);
    parts.push(format.groupStage === 'double' ? 'double round robin' : 'single round robin');
  } else {
    parts.push('straight knockout');
  }
  if (format.knockout === 'quarterfinal') parts.push('QF → SF → Final');
  else if (format.knockout === 'semifinal') parts.push('SF → Final');
  else if (format.knockout === 'final') parts.push('Final');
  else parts.push('no knockout');
  if (format.thirdPlace) parts.push('3rd place match');
  if (format.placement) parts.push('5th/6th place match');
  return parts.join(' · ');
}

function roundRobin(teams) {
  const list = teams.slice();
  if (list.length % 2) list.push(null);
  const rounds = [];
  for (let r = 0; r < list.length - 1; r++) {
    const round = [];
    for (let i = 0; i < list.length / 2; i++) {
      const a = list[i];
      const b = list[list.length - 1 - i];
      if (!a || !b) continue;
      // Alternate home advantage so a group is not lopsided.
      round.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(round);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

// If every team carries an explicit group index, honour it. Otherwise spread
// teams across groups in snake order (the old automatic behaviour).
function splitGroups(teams, groups) {
  const manual = teams.length > 0 && teams.every(team => Number.isInteger(team.group));
  if (manual) {
    const buckets = Array.from({ length: groups }, () => []);
    for (const team of teams) {
      if (team.group < 0 || team.group >= groups) {
        return { error: `Team "${team.name}" is assigned to a group outside 1–${groups}` };
      }
      buckets[team.group].push(team);
    }
    const empty = buckets.findIndex(bucket => bucket.length < 2);
    if (empty !== -1) {
      return { error: `Group ${String.fromCharCode(65 + empty)} needs at least two teams` };
    }
    return { groups: buckets };
  }

  const buckets = Array.from({ length: groups }, () => []);
  teams.forEach((team, i) => {
    const row = Math.floor(i / groups);
    const col = i % groups;
    buckets[row % 2 ? groups - 1 - col : col].push(team);
  });
  return { groups: buckets };
}

/**
 * Group-stage fixtures. Teams may already know their group; otherwise they are
 * split automatically. Returns { games } or { error }; no games are stored here.
 */
function buildGroupFixtures({ tournament, teams, format, startAt, makeId }) {
  if (!format || format.groupStage === 'none') return { games: [] };

  const split = splitGroups(teams, format.groups);
  if (split.error) return { error: split.error };
  const groups = split.groups;
  const games = [];
  let slot = 0;
  const gapMs = 2 * 60 * 60 * 1000;
  const start = startAt || Date.now() + 24 * 60 * 60 * 1000;
  const multi = format.groups > 1;

  for (let gi = 0; gi < groups.length; gi++) {
    const rounds = roundRobin(groups[gi]);
    const legs = format.groupStage === 'double' ? 2 : 1;
    let roundNumber = 0;
    for (let leg = 0; leg < legs; leg++) {
      for (const round of rounds) {
        roundNumber += 1;
        const prefix = multi ? `Group ${String.fromCharCode(65 + gi)} · ` : '';
        for (const [a, b] of round) {
          if (games.length >= MAX_FIXTURE_GAMES) {
            return { error: `That format creates more than ${MAX_FIXTURE_GAMES} group games. Use more groups or a single round robin.` };
          }
          const home = leg === 0 ? a : b;
          const away = leg === 0 ? b : a;
          games.push({
            id: makeId(),
            tournamentId: tournament.id,
            sport: tournament.sport,
            homeTeamId: home.id,
            awayTeamId: away.id,
            stage: 'group',
            round: `${prefix}Round ${roundNumber}`,
            venue: '',
            scheduledAt: start + slot * gapMs
          });
          slot += 1;
        }
      }
    }
  }
  return { games };
}

// Standard single-elimination seeding for a power-of-two bracket: adjacent
// seeds are paired and adjacent pairs meet in the next round.
function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next = [];
    for (const seed of order) {
      next.push(seed, sum - seed);
    }
    order = next;
  }
  return order.slice(0, size);
}

function bracketSize(knockout) {
  if (knockout === 'quarterfinal') return 8;
  if (knockout === 'semifinal') return 4;
  if (knockout === 'final') return 2;
  return 0;
}

function firstKnockoutStage(knockout) {
  if (knockout === 'quarterfinal') return 'qf';
  if (knockout === 'semifinal') return 'sf';
  if (knockout === 'final') return 'final';
  return '';
}

export {
  normalizeFormat,
  stagesFor,
  stageLabel,
  formatSummary,
  buildGroupFixtures,
  splitGroups,
  seedOrder,
  bracketSize,
  firstKnockoutStage,
  KNOCKOUT_SEQUENCE,
  STAGE_LABELS,
  MAX_FIXTURE_GAMES
};
