const test = require('node:test');
const assert = require('node:assert/strict');
const { splitBlocks, parseBlock } = require('../src/parser.js');

// Sample 1: labelled paste, the way VR says he will dump it (YouTube + Instagram in one box).
const SAMPLE_LABELLED = `Title: I cut my 3am coffee routine into 40 seconds #Shorts
Description: Quick look at the setup I use before a late shift. Full breakdown is on the channel.
Tags: coffee, morning routine, vlog
Instagram: coffee at 3am hits different ☕ #reels #coffee #dayinmylife
YouTube captions: Coffee, then the grinder, then the quiet part where nothing happens.`;

// Sample 2: no labels at all, one mixed paragraph. First line is the title,
// the rest is description, the Instagram part is labelled.
const SAMPLE_UNLABELLED = `Night drive through the city, no music, just the engine #driving #nightdrive
Shot on a phone at 2am, nothing edited except the cut. Subscribe if you like quiet content.
IG: night drive, no music, just the hum. #carsofinstagram #nightdrive`;

// Sample 3: two videos in one paste, separated by ---. The second title is too long
// and has angle brackets, so the parser must cut and clean it and say so.
const SAMPLE_TWO_BLOCKS = `YT title: Sourdough day 1 - why my starter smelled like nail polish <and what I did>
YT desc: Feeding schedule, the mistakes I made, and what I'd do again. Part two next week.
insta caption: day one of the sourdough experiment. wish me luck #bread #sourdough #baking
---
Title: Sourdough day 2 ${'x'.repeat(120)}
Description: Second feed, bubbles, no panic.
Instagram caption: day 2 #bread #sourdough`;

test('labelled sample: every field is split out', () => {
  const r = parseBlock(SAMPLE_LABELLED);
  assert.equal(r.title, 'I cut my 3am coffee routine into 40 seconds #Shorts');
  assert.equal(r.description, 'Quick look at the setup I use before a late shift. Full breakdown is on the channel.');
  assert.equal(r.instagramCaption, 'coffee at 3am hits different ☕ #reels #coffee #dayinmylife');
  assert.equal(r.youtubeCaptions, 'Coffee, then the grinder, then the quiet part where nothing happens.');
  assert.deepEqual(r.tags, ['coffee', 'morning routine', 'vlog', 'Shorts', 'reels', 'coffee', 'dayinmylife'].filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i));
  assert.deepEqual(r.hashtags, ['#Shorts', '#reels', '#coffee', '#dayinmylife']);
  assert.deepEqual(r.warnings, []);
});

test('unlabelled mixed paragraph: first line is title, rest is description, IG line is picked up', () => {
  const r = parseBlock(SAMPLE_UNLABELLED);
  assert.equal(r.title, 'Night drive through the city, no music, just the engine #driving #nightdrive');
  assert.equal(r.description, 'Shot on a phone at 2am, nothing edited except the cut. Subscribe if you like quiet content.');
  assert.equal(r.instagramCaption, 'night drive, no music, just the hum. #carsofinstagram #nightdrive');
  assert.ok(r.warnings.some((w) => /first line is used as the title/.test(w)));
  assert.ok(r.tags.includes('driving') && r.tags.includes('carsofinstagram'));
});

test('two blocks, long and bracketed title: split, cut to 100 characters, cleaned, warned', () => {
  const blocks = splitBlocks(SAMPLE_TWO_BLOCKS);
  assert.equal(blocks.length, 2);

  const first = parseBlock(blocks[0]);
  assert.equal(first.title, 'Sourdough day 1 - why my starter smelled like nail polish and what I did');
  assert.equal(first.description, "Feeding schedule, the mistakes I made, and what I'd do again. Part two next week.");
  assert.equal(first.instagramCaption, 'day one of the sourdough experiment. wish me luck #bread #sourdough #baking');
  assert.deepEqual(first.warnings, ['removed < and > from the title (YouTube refuses them)']);

  const second = parseBlock(blocks[1]);
  assert.equal(Array.from(second.title).length, 100);
  assert.ok(second.warnings.includes('title cut to 100 characters'));
  assert.equal(second.instagramCaption, 'day 2 #bread #sourdough');
});

test('empty input: no crash, title warning, no block', () => {
  assert.deepEqual(splitBlocks('   \n---\n  '), []);
  const r = parseBlock('');
  assert.equal(r.title, '');
  assert.deepEqual(r.warnings, ['no title found']);
});
