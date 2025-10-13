"use client";

import { useState } from "react";
import { Link } from "react-router-dom";
import emailjs from "@emailjs/browser";

function ContactForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const resetField = () => {
    setEmail("");
    setMessage("");
    setSubject("");
    setName("");
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    emailjs
      .sendForm(
        "service_wziq1r3",
        "template_5z514ui",
        e.target as HTMLFormElement,
        "wH0cTcKyXxGeyTsgQ"
      )
      .then(() => {
        alert("Email sent successfully!");
      })
      .catch((error) => {
        alert(String(error));
      });

    resetField();
    e.currentTarget.reset();
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 px-4 sm:px-8">
      <div className="w-full max-w-lg bg-white shadow-lg rounded-2xl p-8">
        <h1 className="text-2xl font-semibold text-center mb-2">Contact Us</h1>
        <p className="text-center text-gray-600 mb-6">
          For any bug reports or feedback, please send us an email here!
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Name
            </label>
            <input
              type="text"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 w-full border border-gray-300 rounded-md p-2 focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 w-full border border-gray-300 rounded-md p-2 focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="subject" className="block text-sm font-medium text-gray-700">
              Subject
            </label>
            <input
              type="text"
              name="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              className="mt-1 w-full border border-gray-300 rounded-md p-2 focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="message" className="block text-sm font-medium text-gray-700">
              Message
            </label>
            <textarea
              name="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              required
              className="mt-1 w-full border border-gray-300 rounded-md p-2 focus:ring-2 focus:ring-black focus:outline-none"
            ></textarea>
          </div>

          <button
            type="submit"
            className="w-full bg-black text-white py-2 rounded-md hover:bg-gray-800 transition-colors"
          >
            Send Message
          </button>
        </form>

        {/* 👇 Back to Home button */}
        <button
          onClick={() => router.push("/")}
          className="w-full mt-4 border border-gray-300 py-2 rounded-md hover:bg-gray-100 transition-colors"
        >
            <Link
                to="/"
            >
                ← Back to Home
            </Link>
        </button>
      </div>
    </div>
  );
}

export default ContactForm;
