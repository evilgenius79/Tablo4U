// @ts-check
/**
 * @file Sample data matching Tablo's native JSON shapes, for MOCK mode so the
 * UI can be developed without a live Tablo.
 */

const now = Date.now();

/**
 * @param {number} startOffsetMin
 * @param {number} durationMin
 * @param {string} title
 * @param {string} desc
 * @returns {any}
 */
function airing(startOffsetMin, durationMin, title, desc) {
    return {
        identifier: `air_${title}_${startOffsetMin}`.replace(/\s+/g, '_'),
        title,
        datetime: new Date(now + startOffsetMin * 60000).toISOString(),
        duration: durationMin * 60,
        kind: 'episode',
        description: desc,
        images: [],
        show: { title }
    };
}

const channels = [
    { identifier: 'S1_004_01', name: 'KOMO', kind: 'ota', logos: [{ kind: 'lightLarge', url: '' }], ota: { major: 4, minor: 1, network: 'ABC', callSign: 'KOMO' } },
    { identifier: 'S1_005_01', name: 'KING', kind: 'ota', logos: [], ota: { major: 5, minor: 1, network: 'NBC', callSign: 'KING' } },
    { identifier: 'S1_007_01', name: 'KIRO', kind: 'ota', logos: [], ota: { major: 7, minor: 1, network: 'CBS', callSign: 'KIRO' } },
    { identifier: 'S1_013_01', name: 'KCTS', kind: 'ota', logos: [], ota: { major: 13, minor: 1, network: 'PBS', callSign: 'KCTS' } },
    { identifier: 'S1_011_01', name: 'KSTW', kind: 'ota', logos: [], ota: { major: 11, minor: 1, network: 'CW', callSign: 'KSTW' } },
    { identifier: 'O1_206_00', name: 'Pluto Movies', kind: 'ott', logos: [], ott: { major: 206, minor: 0, network: 'Pluto Movies', callSign: 'PLUTO', streamUrl: '' } }
];

/** @type {Record<string, any[]>} */
const guide = {
    S1_004_01: [airing(-20, 60, 'Good Morning America', 'Morning news and lifestyle.'), airing(40, 30, 'Local News', 'Regional headlines.'), airing(70, 30, 'Jeopardy!', 'Quiz show.')],
    S1_005_01: [airing(-10, 30, 'Today', 'Morning show.'), airing(20, 60, 'The Kelly Clarkson Show', 'Talk and music.'), airing(80, 60, 'Days of Our Lives', 'Drama.')],
    S1_007_01: [airing(-25, 60, 'CBS Mornings', 'News.'), airing(35, 60, 'The Price Is Right', 'Game show.'), airing(95, 30, 'Young & Restless', 'Soap.')],
    S1_013_01: [airing(-5, 60, 'Nature', 'Wildlife documentary.'), airing(55, 60, 'NOVA', 'Science documentary.')],
    S1_011_01: [airing(-15, 30, 'Whose Line Is It Anyway', 'Improv comedy.'), airing(15, 60, 'Penn & Teller: Fool Us', 'Magic competition.'), airing(75, 30, 'Modern Family', 'Sitcom.')],
    O1_206_00: [airing(-40, 120, 'Action Movie Marathon', 'Back-to-back films.'), airing(80, 110, 'Sci-Fi Classic', 'A cult favorite.')]
};

module.exports = { channels, guide };
