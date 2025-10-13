import { Link } from 'react-router-dom';

const Home: React.FC = () => {
  return (
    <div className="w-full h-screen flex flex-col justify-center items-center gap-y-8">
      <h1 className="text-4xl font-semibold">SpeakUp</h1>
      <hr className="border w-96" />
      <p className="text-xl">I am a/an&hellip;</p>
      <div className="flex gap-x-4">
        <Link
          to="/join"
          className="w-48 h-48 rounded-2xl bg-gray-200 flex items-center justify-center text-2xl"
        >
          Student
        </Link>
        <Link
          to="/create"
          className="w-48 h-48 rounded-2xl bg-gray-200 flex items-center justify-center text-2xl"
        >
          Instructor
        </Link>
      </div>
      <hr className="border w-96" />
      <p>
        <span>or </span>
        <Link
          className="text-blue-600 hover:text-blue-700 underline underline-offset-4"
          to="/download"
        >
          Download Past Recordings
        </Link>
      </p>
      <p>
        <Link
          className="text-blue-600 hover:text-blue-700 underline underline-offset-4"
          to="/contact"
        >
          Send Feedback / Report Issues
        </Link>
      </p>
    </div>
  );
};

export default Home;
export const Component = Home;
Component.displayName = 'Home';
