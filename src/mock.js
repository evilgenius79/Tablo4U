// @ts-check
/**
 * @file Sample data matching Tablo's native JSON shapes, for MOCK mode so the
 * UI can be developed without a live Tablo.
 */

const now = Date.now();

/**
 * Tiny inline SVG "logo" so the UI can show channel logos in mock mode.
 * @param {string} text
 * @param {string} color
 * @returns {string} data URI
 */
function logo(text, color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" rx="8" fill="${color}"/><text x="60" y="38" font-family="Arial" font-size="22" font-weight="bold" fill="#fff" text-anchor="middle">${text}</text></svg>`;

    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/**
 * A generic 16:9 program still, so the detail view has an image in mock mode.
 * @param {string} color
 * @returns {string} data URI
 */
function still(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${color}"/><circle cx="160" cy="90" r="34" fill="rgba(255,255,255,.85)"/><path d="M150 72 l30 18 -30 18 z" fill="${color}"/></svg>`;

    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/**
 * @param {number} startOffsetMin
 * @param {number} durationMin
 * @param {string} title
 * @param {string} desc
 * @param {any} [extra]
 * @returns {any}
 */
function airing(startOffsetMin, durationMin, title, desc, extra = {}) {
    return {
        identifier: `air_${title}_${startOffsetMin}`.replace(/\s+/g, '_'),
        title,
        datetime: new Date(now + startOffsetMin * 60000).toISOString(),
        duration: durationMin * 60,
        kind: 'episode',
        description: desc,
        genres: extra.genres || [],
        images: extra.image ? [{ kind: 'still', url: extra.image }] : [],
        show: { title: extra.show || title },
        episode: extra.episode || undefined
    };
}

const channels = [
    { identifier: 'S1_004_01', name: 'KOMO', kind: 'ota', logos: [{ kind: 'lightLarge', url: logo('ABC', '#0a5cad') }], ota: { major: 4, minor: 1, network: 'ABC', callSign: 'KOMO' } },
    { identifier: 'S1_005_01', name: 'KING', kind: 'ota', logos: [{ kind: 'lightLarge', url: logo('NBC', '#6b4fbb') }], ota: { major: 5, minor: 1, network: 'NBC', callSign: 'KING' } },
    { identifier: 'S1_007_01', name: 'KIRO', kind: 'ota', logos: [{ kind: 'lightLarge', url: logo('CBS', '#0b6cc4') }], ota: { major: 7, minor: 1, network: 'CBS', callSign: 'KIRO' } },
    { identifier: 'S1_013_01', name: 'KCTS', kind: 'ota', logos: [{ kind: 'lightLarge', url: logo('PBS', '#2b3a67') }], ota: { major: 13, minor: 1, network: 'PBS', callSign: 'KCTS' } },
    { identifier: 'S1_011_01', name: 'KSTW', kind: 'ota', logos: [{ kind: 'lightLarge', url: logo('CW', '#1f9d5f') }], ota: { major: 11, minor: 1, network: 'CW', callSign: 'KSTW' } },
    { identifier: 'O1_206_00', name: 'Pluto Movies', kind: 'ott', logos: [{ kind: 'lightLarge', url: logo('PLUTO', '#c2410c') }], ott: { major: 206, minor: 0, network: 'Pluto Movies', callSign: 'PLUTO', streamUrl: '' } }
];

/** @type {Record<string, any[]>} */
const guide = {
    S1_004_01: [
        airing(-20, 60, 'Good Morning America', 'The latest morning news, weather, and lifestyle segments with the GMA team.', { genres: ['News', 'Talk'], image: still('#0a5cad') }),
        airing(40, 30, 'Local News at Noon', 'Regional headlines, traffic, and forecast.', { genres: ['News'] }),
        airing(70, 30, 'Jeopardy!', 'Contestants answer trivia across a range of categories.', { genres: ['Game Show'], episode: { season: { number: 41 }, episodeNumber: 112 } })
    ],
    S1_005_01: [
        airing(-10, 30, 'Today', 'Morning show with news, interviews, and cooking.', { genres: ['News', 'Talk'] }),
        airing(20, 60, 'The Kelly Clarkson Show', 'Celebrity guests, music, and games.', { genres: ['Talk'], image: still('#6b4fbb') }),
        airing(80, 60, 'Days of Our Lives', 'The lives and loves of the residents of Salem.', { genres: ['Drama', 'Soap'], episode: { season: { number: 60 }, episodeNumber: 44 } })
    ],
    S1_007_01: [
        airing(-25, 60, 'CBS Mornings', 'In-depth news and feature reporting.', { genres: ['News'] }),
        airing(35, 60, 'The Price Is Right', 'Contestants compete to win prizes by guessing prices.', { genres: ['Game Show'], image: still('#0b6cc4') }),
        airing(95, 30, 'The Young and the Restless', 'Drama among the families of Genoa City.', { genres: ['Drama', 'Soap'] })
    ],
    S1_013_01: [
        airing(-5, 60, 'Nature', 'Stunning wildlife photography from around the globe.', { genres: ['Documentary'], image: still('#2b3a67') }),
        airing(55, 60, 'NOVA', 'Science documentary exploring a cutting-edge topic.', { genres: ['Documentary', 'Science'] })
    ],
    S1_011_01: [
        airing(-15, 30, 'Whose Line Is It Anyway?', 'Improv comedy games with a rotating cast.', { genres: ['Comedy'] }),
        airing(15, 60, 'Penn & Teller: Fool Us', 'Magicians try to fool the legendary duo.', { genres: ['Reality', 'Magic'], image: still('#1f9d5f') }),
        airing(75, 30, 'Modern Family', 'The mockumentary sitcom about a big blended family.', { genres: ['Comedy'], episode: { season: { number: 6 }, episodeNumber: 9 } })
    ],
    O1_206_00: [
        airing(-40, 120, 'Action Movie Marathon', 'Back-to-back action films all afternoon.', { genres: ['Movie', 'Action'], image: still('#c2410c') }),
        airing(80, 110, 'Sci-Fi Classic', 'A beloved cult science-fiction feature.', { genres: ['Movie', 'Sci-Fi'] })
    ]
};

module.exports = { channels, guide };
