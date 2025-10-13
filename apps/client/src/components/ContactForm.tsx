"use client"

import React, { useState } from 'react';
import emailjs from '@emailjs/browser';
import { toast } from "react-hot-toast";

function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const resetField = () => {
    setEmail("");
    setMessage(""); 
    setSubject(""); 
    setName("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    emailjs.sendForm("service_wziq1r3", "template_5z514ui", e.target, "wH0cTcKyXxGeyTsgQ" )
    .then((result) => {
      toast.success('Email has been sent!');
    }, (error) => {
      toast.error(error);
    });
    resetField();
    e.target.reset();
  };

  return (
    <div className='w-full px-10 sm:px-20 lg:px-60 md:px-40'>
      <h1 className='flex flex-center w-full'>For any queries or feedback, please send us an email here!</h1><br/>
        <form onSubmit={handleSubmit} className='justify-center'> 
          <label htmlFor="name">Name:</label><br/>
          <input
            type="text"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="form_input"
          />
          <br />

          <label htmlFor="email">Email:</label><br/>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="form_input"
          />
          <br />

          <label htmlFor="subject">Subject:</label><br/>
          <input
            type="text"
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            className="form_input"
          />
          <br />


          <label htmlFor="message">Message:</label><br />
          <textarea
            name="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows="5"
            required
            className="form_input"
          ></textarea>
          <br />

          <button type="submit" className='black_btn'>
            Send
          </button>
        </form>
    </div>
  );
}

export default ContactForm;