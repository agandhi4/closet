// Dies on the first image, as an out-of-memory kill would look.
process.on('message', (message) => {
  if (message.type === 'run') process.exit(137);
});
process.on('disconnect', () => process.exit(0));
