// Point d'entrée : /admin affiche l'espace du studio, toute autre adresse affiche le site public.
import { createRoot } from "react-dom/client";
import Public from "./Public.jsx";
import Admin from "./Admin.jsx";
import "./styles.css";

const isAdmin = window.location.pathname.startsWith("/admin");
createRoot(document.getElementById("root")).render(isAdmin ? <Admin /> : <Public />);
