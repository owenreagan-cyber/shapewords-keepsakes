export interface Student {
  id: string;
  name: string;
  shape: string;
  traits: string;
  theme: string;
  colorPalette: string[];
  fontFamily: string;
  density: number;
  emphasis: string;
  aiExpansionProfile: string;
}

export const STUDENTS: Student[] = [
  { id: '1', name: 'Abby', shape: 'Cute teddy bear silhouette', traits: 'kind, warm, caring, sweet, gentle', theme: 'Warm Kindness', colorPalette: ['#000000', '#B76E79'], fontFamily: 'Playfair Display', density: 90, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '2', name: 'Avery', shape: 'Graceful young girl dancer leaping, beautiful ballet silhouette', traits: 'graceful, athletic, leader, creative, beautiful, honest, funny, smart, caring, friendly, fast, sweet', theme: 'bright', colorPalette: ['#00BFFF', '#FF69B4'], fontFamily: 'Impact', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '3', name: 'CharlieKate', shape: 'Cheerleader jumping with pom-poms silhouette', traits: 'energetic, loud, spirited, fun, joyful', theme: 'Energy and Leadership', colorPalette: ['#000000', '#DC143C'], fontFamily: 'Poppins', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '4', name: 'Dominic', shape: 'Cool 10 year old boy dancing silhouette', traits: 'performer, confident, active, cool, fun', theme: 'Performance and Confidence', colorPalette: ['#000000', '#4169E1'], fontFamily: 'Oswald', density: 85, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '5', name: 'Elana', shape: '10 year old girl leaping in dance silhouette', traits: 'artistic, excellent, poised, creative, joyful', theme: 'Artistic Excellence', colorPalette: ['#000000', '#DDA0DD'], fontFamily: 'Cormorant Garamond', density: 80, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '6', name: 'Elise', shape: '10 year old girl doing ballet silhouette', traits: 'elegant, classical, precise, beautiful, neat', theme: 'Elegance', colorPalette: ['#000000', '#FFD700'], fontFamily: 'Playfair Display', density: 80, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '7', name: 'Emma', shape: 'Girl singing into a microphone silhouette', traits: 'singer, joyful, friendly, loud, happy', theme: 'Performance and Joy', colorPalette: ['#000000', '#FF00FF'], fontFamily: 'Montserrat', density: 90, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '8', name: 'Evie', shape: 'Cute red panda silhouette', traits: 'adventurous, curious, wild, cute, playful', theme: 'Adventure', colorPalette: ['#000000', '#CC5500'], fontFamily: 'Poppins', density: 75, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '9', name: 'Evelyn', shape: 'Cute dog running silhouette', traits: 'loyal, friendly, steadfast, playful, sweet', theme: 'Loyalty and Friendship', colorPalette: ['#000000', '#228B22'], fontFamily: 'Lora', density: 75, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '10', name: 'Graham', shape: '10 year old boy swinging baseball bat silhouette', traits: 'baseball, captain, strong, athletic, leader', theme: 'Team Captain', colorPalette: ['#000000', '#000080'], fontFamily: 'Bebas Neue', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '11', name: 'Grayson', shape: '10 year old boy throwing a football silhouette', traits: 'football, competitive, tough, strong, athletic', theme: 'Competitive Spirit', colorPalette: ['#000000', '#800000'], fontFamily: 'Oswald', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '12', name: 'Isabelle', shape: 'First place ribbon medal silhouette', traits: 'achiever, excellence, winner, smart, proud', theme: 'Achievement', colorPalette: ['#000000', '#FFD700'], fontFamily: 'Cinzel', density: 90, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '13', name: 'Jace', shape: 'Video game controller silhouette', traits: 'gamer, tech, logic, smart, fun', theme: 'Technology and Creativity', colorPalette: ['#000000', '#7DF9FF'], fontFamily: 'Inter', density: 85, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '14', name: 'Jack', shape: 'Cool eagle flying silhouette', traits: 'free, soaring, leader, cool, brave', theme: 'Freedom and Leadership', colorPalette: ['#000000', '#87CEEB'], fontFamily: 'Montserrat', density: 80, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '15', name: 'Landon', shape: 'Cool lightning bolt silhouette', traits: 'explosive, energetic, loud, fast, cool', theme: 'Energy', colorPalette: ['#000000', '#FFA500'], fontFamily: 'Bebas Neue', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '16', name: 'Logan', shape: 'Cool robot silhouette', traits: 'innovator, engineering, smart, builder, logical', theme: 'Innovation', colorPalette: ['#000000', '#6A5ACD'], fontFamily: 'Inter', density: 85, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '17', name: 'Lucy', shape: 'Beautiful horse galloping silhouette', traits: 'strong, graceful, wild, fast, free', theme: 'Strength and Grace', colorPalette: ['#000000', '#8B4513'], fontFamily: 'Playfair Display', density: 90, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '18', name: 'Madison', shape: '10 year old girl doing gymnastics tumbling silhouette', traits: 'gymnast, determined, flexible, strong, brave', theme: 'Determination', colorPalette: ['#000000', '#800080'], fontFamily: 'Poppins', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '19', name: 'Max', shape: 'Blocky Minecraft-style pixel character silhouette', traits: 'creative, funny, builder, silly, gamer', theme: 'Creativity and Humor', colorPalette: ['#000000', '#50C878'], fontFamily: 'Orbitron', density: 90, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '20', name: 'Mia', shape: 'Cute snake coiled silhouette', traits: 'curious, clever, sneaky, fast, smart', theme: 'Curiosity', colorPalette: ['#000000', '#50C878'], fontFamily: 'Lora', density: 75, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '21', name: 'Misha', shape: 'Open laptop computer silhouette', traits: 'coder, creative, quiet, smart, focused', theme: 'Innovation', colorPalette: ['#000000', '#008080'], fontFamily: 'Inter', density: 85, emphasis: 'Medium', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '22', name: 'Nixon', shape: 'Football helmet silhouette', traits: 'football, strong, tough, brave, determined', theme: 'Strength', colorPalette: ['#000000', '#DC143C'], fontFamily: 'Oswald', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '23', name: 'Stephen', shape: '10 year old boy kicking a soccer ball silhouette', traits: 'soccer, teamwork, fast, runner, strong', theme: 'Teamwork', colorPalette: ['#000000', '#4CBB17'], fontFamily: 'Bebas Neue', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '24', name: 'Torren', shape: '10 year old boy diving to save a soccer goal silhouette', traits: 'goalie, determined, brave, quick, clutch', theme: 'Determination', colorPalette: ['#000000', '#00008B'], fontFamily: 'Oswald', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
  { id: '25', name: 'Wayde', shape: '10 year old boy playing ice hockey silhouette', traits: 'hockey, strong, character, fast, cool', theme: 'Strength and Character', colorPalette: ['#000000', '#ADD8E6'], fontFamily: 'Bebas Neue', density: 95, emphasis: 'High', aiExpansionProfile: 'Kid-friendly Positive Character Traits' },
];

export const FONT_OPTIONS = ['Bebas Neue', 'Caveat', 'Cinzel', 'Cormorant Garamond', 'Great Vibes', 'Impact', 'Lora', 'Montserrat', 'Orbitron', 'Oswald', 'Playfair Display', 'Poppins', 'Space Grotesk', 'Inter'];
export const THEMES = ['Classic B&W', 'Primary School', 'Athletic', 'Gold Foil', 'Soft Watercolor', 'Modern Minimalist'];
export const SILHOUETTE_STYLES = ['Premium Print', 'Minimal', 'Elegant', 'Modern', 'Sports', 'Cartoon'];
export const OPTIMIZATION_PRESETS = ['Premium Print', 'Conservative', 'Balanced', 'Artistic'];
