import bcrypt from 'bcryptjs';

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hashedPassword) => {
  if (!password || !hashedPassword) return false;
  if (password === hashedPassword) return true;
  try {
    return await bcrypt.compare(password, hashedPassword);
  } catch (err) {
    return false;
  }
};

export default { hashPassword, comparePassword };
