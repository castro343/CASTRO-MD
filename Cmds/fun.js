const { pick } = require('../lib/utils');
const pickFrom = (a) => a[Math.floor(Math.random()*a.length)];
const ball = ['It is certain. 🎯','Without a doubt. ✅','Yes, definitely. 💚','Most likely. 👀','The signs point to yes. ✨','Ask again later. ⏳','Cannot predict now. 🔮',"Don't count on it. 😬",'My sources say no. 🚫','Very doubtful. 🌚'];
const truths = ['What is one thing you have never told your closest friend?','Who was your first crush?','What is your biggest fear in a relationship?','What is the most embarrassing thing you have done?','Have you ever pretended to like a gift?'];
const dares = ['Give someone in this chat a genuine compliment.','Describe your crush using only three emojis.','Share a funny harmless memory.','Let the group choose your status for the next 10 minutes.'];
const roasts = ['You bring everyone so much joy… when you leave the room. 😭','Your Wi-Fi has more connection than your arguments.','You are proof that loading screens can become people.','Even autocorrect gives up trying to understand you.'];
const compliments = ['You have a way of making ordinary moments feel special. ✨','Your energy makes the room better. Keep that.','You are more capable than you give yourself credit for. 💙','Your kindness is a real flex.'];
const quotes = ['Great things are done by a series of small things brought together. — Vincent van Gogh','It always seems impossible until it is done. — Nelson Mandela','Dream big. Start small. Act now.','Your future is created by what you do today, not tomorrow.'];
const flirts = ['Are you a notification? Because you just made my day light up. 💬','If smiles were currency, you would be a billionaire. 😉','I was having a normal day until you crossed my mind.'];
const characters = ['Naruto Uzumaki 🍥','Monkey D. Luffy 🏴‍☠️','Levi Ackerman ⚔️','Satoru Gojo 🌀','Tanjiro Kamado 🌊','Mikasa Ackerman 🧣','Kakashi Hatake 📖'];
const clean = s => String(s||'').trim().slice(0,80);
const score = s => { let h=2166136261; for(const ch of s.toLowerCase()) h=Math.imul(h^ch.charCodeAt(0),16777619); return (h>>>0)%101; };
module.exports = [
{name:'joke',description:'Get a random joke',run:async({reply})=>reply(pick(['Why do programmers prefer dark mode? Because light attracts bugs.','There are 10 kinds of people: those who understand binary and those who do not.','A SQL query walks into a bar and asks two tables: can I join you?']))},
{name:'flip',description:'Flip a coin',run:async({reply})=>reply(Math.random()<.5?'Heads':'Tails')},
{name:'dice',aliases:['roll'],description:'Roll a die',run:async({reply,args})=>{const n=Math.min(Math.max(parseInt(args[0],10)||6,2),1000);return reply('You rolled '+(1+Math.floor(Math.random()*n))+' (d'+n+')');}},
{name:'8ball',description:'Ask the magic 8-ball',run:async({reply,text,prefix})=>reply(text?'🎱 '+pickFrom(ball)+'\nQuestion: '+text.slice(0,250):'Usage: '+prefix+'8ball <question>')},
{name:'ship',aliases:['compatibility','lovetest','ishqmeter'],description:'Playful compatibility score: .ship name1 | name2',run:async({reply,text,prefix})=>{const [a,b]=text.split('|').map(clean);if(!a||!b)return reply('Usage: '+prefix+'ship name 1 | name 2');const n=score([a,b].sort().join('|'));return reply('💞 '+a+' + '+b+'\nCompatibility: '+n+'%\n'+(n>80?'Power couple energy! 💍':n>55?'There might be a spark. ✨':n>30?'Could use a little teamwork. 😅':'The stars are still negotiating. 😂')+'\nJust for fun — not a real compatibility test.');}},
{name:'roast',description:'Get a playful roast',run:async({reply,text})=>reply('🔥 '+(text?clean(text)+': ':'')+pickFrom(roasts))},
{name:'compliment',description:'Send a wholesome compliment',run:async({reply,text})=>reply('💙 '+(text?clean(text)+', ':'')+pickFrom(compliments))},
{name:'quote',description:'Get an inspirational quote',run:async({reply})=>reply('✨ '+pickFrom(quotes))},
{name:'flirt',description:'Get a playful pickup line',run:async({reply})=>reply('😉 '+pickFrom(flirts))},
{name:'truth',description:'Get a truth question',run:async({reply})=>reply('🫣 TRUTH: '+pickFrom(truths))},
{name:'dare',description:'Get a fun dare',run:async({reply})=>reply('🎯 DARE: '+pickFrom(dares))},
{name:'character',aliases:['animecharacter'],description:'Get a random anime character',run:async({reply})=>reply('🎭 Your anime character: '+pickFrom(characters))}
];