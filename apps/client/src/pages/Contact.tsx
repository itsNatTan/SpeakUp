import ContactForm from '../components/ContactForm'
import { FC } from 'react';

const Contact: FC = () => {
  return (
    <>
      <p className="text-center text-2xl font-bold mb-10">
        Contact Us
      </p>
      <ContactForm />
    </>
  )
}

export default Contact;
export const Component = Contact;
Component.displayName = 'Contact';