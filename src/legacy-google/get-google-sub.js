// Get your Google Sub ID for API testing
import { connectToDatabase, getDatabase } from './src/config/database.js';

async function getGoogleSub() {
  try {
    await connectToDatabase();
    const db = await getDatabase();
    const users = await db.collection('users').find({}).toArray();
    
    if (users.length === 0) {
      console.error('❌ No users found!');
      process.exit(1);
    }
    
    console.log('📋 YOUR GOOGLE SUB ID:');
    console.log('='.repeat(70));
    console.log(users[0].google_sub);
    console.log('='.repeat(70));
    console.log('');
    console.log('📧 Email:', users[0].email);
    console.log('');
    console.log('💡 Use this ID for API testing!');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

getGoogleSub();
