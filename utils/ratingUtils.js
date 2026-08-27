function getPassengerBadge(avgRating) {
  if (avgRating >= 4.5) return 'Well-behaved passenger';
  if (avgRating >= 3.5) return 'Average passenger';
  if (avgRating >= 2.5) return 'Low rated';
  return 'Caution';
}

module.exports = { getPassengerBadge };
