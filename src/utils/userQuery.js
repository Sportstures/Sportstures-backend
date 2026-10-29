// Shared SQL fragments so every route returns users in the same shape.
// The role is returned as its name (e.g. "learner"), joined from the roles table.
// date_of_birth is formatted in SQL so it is a plain "YYYY-MM-DD" string (no timezone shift).
const USER_SELECT = `u.id, u.email, u.first_name, u.last_name, u.phone,
  to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, u.gender,
  r.name AS role, u.created_at`;

const USER_FROM = 'FROM users u JOIN roles r ON r.id = u.role_id';

module.exports = { USER_SELECT, USER_FROM };
