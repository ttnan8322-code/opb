// cards.extra.js
// Place additional card definitions here so they can be maintained separately
// Export an array named `extraCards` with card objects matching the shape used
// by `cards.js`. Example:
// export const extraCards = [ { id: 'mycard_c_01', name: 'My Card', title: '...', rank: 'C', power: 20, attackRange: [3,9], health: 70, type: 'Support', image: 'https://...' } ];

export const extraCards = [
	{
		id: "luffy_z_newyears_2026",
		name: "(NEW YEARS) Monkey D Luffy",
		title: "Event card",
		rank: "Z",
		power: 500,
		attackRange: [60, 100],
		health: 650,
		type: "Attack",
		specialAttack: { name: "Gomu Gomu no Bajrang Gun", range: [160, 210], gif: "https://files.catbox.moe/toppyn.gif" },
		ability: "Boosts team ATK and HP by 25%",
		boost: { atk: 25, hp: 25 },
		image: "https://files.catbox.moe/iteabf.jpg",
		haki: ["advancedobservation","armament","advancedconqueror"],
		isUpgrade: false,
		pullable: false
	}
];
